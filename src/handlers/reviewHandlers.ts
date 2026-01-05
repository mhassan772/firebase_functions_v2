import { admin } from "../config/admin";
import { Timestamp } from "firebase-admin/firestore";

export interface ReviewRequest {
  method: string;
  comment: string;
  book_rate: number;
  narrator_rate: number;
  book_guid: string;
  user_guid: string;
}

/**
 * Core logic for handling comments with the new schema
 */
export async function handleComment({ method, comment, book_rate = 0, narrator_rate = 0, book_guid, user_guid }: ReviewRequest): Promise<{ code: number; message: string }> {
  const bookDocRef = admin.firestore().collection("re_review_book").doc(book_guid);
  const commentDocRef = admin.firestore().collection("re_review_content").doc(`${book_guid}_${user_guid}`);

  // Use a Firestore transaction
  return await admin.firestore().runTransaction(async (transaction) => {
    // Fetch the book document
    const bookDoc = await transaction.get(bookDocRef);
    let bookData: any;

    if (bookDoc.exists) {
      bookData = bookDoc.data();
    } else {
      if (method === "update" || method === "delete") {
        throw new Error("Book does not exist or user has not commented on this book.");
      }
      // Initialize book data
      bookData = {
        book_rate: 0,
        book_rate_number: 0,
        narrator_rate: 0,
        narrator_rate_number: 0,
        overall_rate: 0,
        number_of_comments: 0,
      };
      transaction.set(bookDocRef, bookData);
    }

    const commentDoc = await transaction.get(commentDocRef);
    let commentData: any;
    const commentExists = commentDoc.exists;
    const isSoftDeleted = commentExists && commentDoc.data()?.is_deleted === true;

    if (commentExists) {
      commentData = commentDoc.data();
    } else {
      if (method === "update" || method === "delete") {
        throw new Error("User has not commented on this book.");
      }
      commentData = {
        book_guid,
        user_guid,
        num_of_likes: 0,
        comment: "",
        book_rate: 0,
        narrator_rate: 0,
        timestamp: null,
        is_there_comment: false,
        is_deleted: false,
      };
    }

    if (method === "put") {
      // Allow put if comment doesn't exist OR if it's soft-deleted (restore it)
      if (commentExists && !isSoftDeleted) {
        throw new Error("User has already commented on this book.");
      }

      // If restoring a soft-deleted comment, preserve num_of_likes
      const num_of_likes = commentExists && commentData.num_of_likes !== undefined 
        ? commentData.num_of_likes 
        : 0;

      // Update book metadata
      const wasSoftDeleted = commentExists && isSoftDeleted;
      
      // Check if comment text changed when restoring (only set is_edited if text changed)
      const oldCommentText = wasSoftDeleted ? (commentData.comment || "") : "";
      const commentTextChanged = wasSoftDeleted && oldCommentText.trim() !== comment.trim();

      // Create or restore the comment
      commentData = {
        book_guid,
        user_guid,
        num_of_likes,
        comment,
        book_rate,
        narrator_rate,
        timestamp: Timestamp.now(),
        is_there_comment: comment.trim() !== "",
        is_deleted: false,
        is_edited: commentTextChanged, // Mark as edited only if comment text changed when restoring
      };
      
      // Increment comment count for both new and restored comments
      // (restored comments had their count decremented when soft-deleted)
      bookData.number_of_comments = Math.max(0, (bookData.number_of_comments || 0) + 1);
      
      // Add ratings (old ratings were removed when soft-deleted, so add new ones)
      if (book_rate > 0) {
        bookData.book_rate = calculateNewRating(bookData.book_rate, bookData.book_rate_number, book_rate);
        bookData.book_rate_number += 1;
      }
      if (narrator_rate > 0) {
        bookData.narrator_rate = calculateNewRating(bookData.narrator_rate, bookData.narrator_rate_number, narrator_rate);
        bookData.narrator_rate_number += 1;
      }

      bookData.overall_rate = calculateOverallRate(
        bookData.book_rate,
        bookData.narrator_rate,
        bookData.book_rate_number,
        bookData.narrator_rate_number
      );

      transaction.set(commentDocRef, commentData);
      transaction.set(bookDocRef, bookData);
      return { code: 200, message: wasSoftDeleted ? "Comment restored successfully." : "Comment added successfully." };
    } else if (method === "update") {
      if (!commentExists) {
        throw new Error("User has not commented on this book.");
      }

      // Reject update if comment is soft-deleted
      if (isSoftDeleted) {
        throw new Error("Cannot update a deleted comment. Please restore it first.");
      }

      // Update the comment
      const oldComment = { book_rate: commentData.book_rate || 0, narrator_rate: commentData.narrator_rate || 0 };
      
      // Check if comment text changed (only set is_edited if text changed, not just ratings)
      const oldCommentText = commentData.comment || "";
      const commentTextChanged = oldCommentText.trim() !== comment.trim();
      
      // Preserve existing is_edited if comment text didn't change, otherwise set to true
      const wasPreviouslyEdited = commentData.is_edited === true;
      const shouldMarkAsEdited = commentTextChanged || wasPreviouslyEdited;

      commentData = {
        ...commentData,
        comment,
        book_rate,
        narrator_rate,
        timestamp: Timestamp.now(),
        is_there_comment: comment.trim() !== "",
        is_deleted: false, // Ensure it's not marked as deleted
        is_edited: shouldMarkAsEdited, // Mark as edited only if comment text changed
      };

      // Update book metadata
      bookData = updateRatings(bookData, oldComment, { book_rate, narrator_rate });

      transaction.set(commentDocRef, commentData);
      transaction.set(bookDocRef, bookData);
      return { code: 200, message: "Comment updated successfully." };
    } else if (method === "delete") {
      if (!commentExists) {
        throw new Error("User has not commented on this book.");
      }

      // If already soft-deleted, do nothing
      if (isSoftDeleted) {
        return { code: 200, message: "Comment is already deleted." };
      }

      // Soft delete: set is_deleted=true instead of actually deleting
      const oldComment = { book_rate: commentData.book_rate || 0, narrator_rate: commentData.narrator_rate || 0 };

      commentData = {
        ...commentData,
        is_deleted: true,
      };

      // Update book metadata to remove ratings
      bookData = deleteRatings(bookData, oldComment);

      transaction.set(commentDocRef, commentData);
      transaction.set(bookDocRef, bookData);
      return { code: 200, message: "Comment deleted successfully." };
    }

    throw new Error("Invalid method.");
  });
}

/**
 * Utility function to calculate new ratings
 */
function calculateNewRating(currentRating: number, ratingCount: number, newRating: number): number {
  if (ratingCount === 0) {
    return parseFloat(newRating.toFixed(1));
  }
  return parseFloat(((currentRating * ratingCount + newRating) / (ratingCount + 1)).toFixed(1));
}

/**
 * Utility function to calculate overall rating
 * Only averages the rated dimensions (non-zero ratings)
 */
function calculateOverallRate(bookRate: number, narratorRate: number, bookRateNumber: number, narratorRateNumber: number): number {
  const ratedCount = (bookRateNumber > 0 ? 1 : 0) + (narratorRateNumber > 0 ? 1 : 0);
  
  if (ratedCount === 0) {
    return 0;
  }
  
  let sum = 0;
  if (bookRateNumber > 0) {
    sum += bookRate;
  }
  if (narratorRateNumber > 0) {
    sum += narratorRate;
  }
  
  return parseFloat((sum / ratedCount).toFixed(1));
}

/**
 * Recalculate ratings for updates
 */
function updateRatings(bookData: any, oldRating: { book_rate: number; narrator_rate: number }, newRating: { book_rate: number; narrator_rate: number }): any {
  // Handle book_rate updates
  if (oldRating.book_rate > 0 && newRating.book_rate > 0) {
    // Update existing rating
    bookData.book_rate = recalculateRating(bookData.book_rate, bookData.book_rate_number, oldRating.book_rate, newRating.book_rate);
  } else if (oldRating.book_rate === 0 && newRating.book_rate > 0) {
    // Add new rating
    bookData.book_rate = calculateNewRating(bookData.book_rate, bookData.book_rate_number, newRating.book_rate);
    bookData.book_rate_number += 1;
  } else if (oldRating.book_rate > 0 && newRating.book_rate === 0) {
    // Remove rating (rating changed from >0 to 0)
    if (bookData.book_rate_number > 0) {
      bookData.book_rate = recalculateRating(bookData.book_rate, bookData.book_rate_number, oldRating.book_rate, 0, true);
      bookData.book_rate_number = Math.max(0, bookData.book_rate_number - 1);
    }
  }
  
  // Handle narrator_rate updates
  if (oldRating.narrator_rate > 0 && newRating.narrator_rate > 0) {
    // Update existing rating
    bookData.narrator_rate = recalculateRating(bookData.narrator_rate, bookData.narrator_rate_number, oldRating.narrator_rate, newRating.narrator_rate);
  } else if (oldRating.narrator_rate === 0 && newRating.narrator_rate > 0) {
    // Add new rating
    bookData.narrator_rate = calculateNewRating(bookData.narrator_rate, bookData.narrator_rate_number, newRating.narrator_rate);
    bookData.narrator_rate_number += 1;
  } else if (oldRating.narrator_rate > 0 && newRating.narrator_rate === 0) {
    // Remove rating (rating changed from >0 to 0)
    if (bookData.narrator_rate_number > 0) {
      bookData.narrator_rate = recalculateRating(bookData.narrator_rate, bookData.narrator_rate_number, oldRating.narrator_rate, 0, true);
      bookData.narrator_rate_number = Math.max(0, bookData.narrator_rate_number - 1);
    }
  }
  
  bookData.overall_rate = calculateOverallRate(
    bookData.book_rate,
    bookData.narrator_rate,
    bookData.book_rate_number,
    bookData.narrator_rate_number
  );
  return bookData;
}

/**
 * Recalculate ratings for deletes
 */
function deleteRatings(bookData: any, removedRating: { book_rate: number; narrator_rate: number }): any {
  if (removedRating.book_rate > 0 && bookData.book_rate_number > 0) {
    bookData.book_rate = recalculateRating(bookData.book_rate, bookData.book_rate_number, removedRating.book_rate, 0, true);
    bookData.book_rate_number = Math.max(0, bookData.book_rate_number - 1);
  }
  if (removedRating.narrator_rate > 0 && bookData.narrator_rate_number > 0) {
    bookData.narrator_rate = recalculateRating(bookData.narrator_rate, bookData.narrator_rate_number, removedRating.narrator_rate, 0, true);
    bookData.narrator_rate_number = Math.max(0, bookData.narrator_rate_number - 1);
  }
  bookData.number_of_comments = Math.max(0, bookData.number_of_comments - 1);
  bookData.overall_rate = calculateOverallRate(
    bookData.book_rate,
    bookData.narrator_rate,
    bookData.book_rate_number,
    bookData.narrator_rate_number
  );
  return bookData;
}

/**
 * Utility function to recalculate ratings
 */
function recalculateRating(currentRating: number, ratingCount: number, oldRating: number, newRating: number, isDelete = false): number {
  if (isDelete) {
    if (ratingCount <= 1) return 0; // Reset to 0 if no ratings left
    return parseFloat(((currentRating * ratingCount - oldRating) / (ratingCount - 1)).toFixed(1));
  } else {
    return parseFloat(((currentRating * ratingCount - oldRating + newRating) / ratingCount).toFixed(1));
  }
}

/**
 * Check if user is banned
 */
export async function isUserBanned(user_guid: string): Promise<boolean> {
  try {
    if (!user_guid) {
      throw new Error("Invalid user_guid provided.");
    }

    const bannedUserDocRef = admin
      .firestore()
      .collection("re_banned_users")
      .doc(user_guid);

    const bannedUserDoc = await bannedUserDocRef.get();

    // Check if the document exists and the user is banned
    if (bannedUserDoc.exists && bannedUserDoc.data()?.banned === true) {
      return true;
    }

    return false;
  } catch (error: any) {
    console.error("Error checking banned user status:", error.message);
    throw new Error("Failed to verify banned status.");
  }
}

/**
 * Core logic for liking/unliking a comment
 */
export async function handleLike(
  comment_guid: string,
  user_guid: string,
  method: "like" | "unlike"
): Promise<{ code: number; message: string }> {
  if (!comment_guid || typeof comment_guid !== "string" || comment_guid.trim() === "") {
    console.error("Error with comment_guid:", comment_guid);
    throw { code: 400, message: "Invalid comment_guid." };
  }

  if (method !== "like" && method !== "unlike") {
    throw { code: 400, message: "Invalid method. Must be 'like' or 'unlike'." };
  }

  // Firestore references
  const commentDocRef = admin.firestore().collection("re_review_content").doc(comment_guid);

  // Use a Firestore transaction
  return await admin.firestore().runTransaction(async (transaction) => {
    // Step 1: Check if the comment exists
    const commentDoc = await transaction.get(commentDocRef);

    if (!commentDoc.exists) {
      throw { code: 508, message: "Comment does not exist." };
    }

    const commentData = commentDoc.data();
    
    // Check if comment is soft-deleted
    if (commentData?.is_deleted === true) {
      throw { code: 508, message: "Comment does not exist." };
    }

    // Step 2: Ensure the user is not the owner of the comment
    if (commentData?.user_guid === user_guid) {
      throw { code: 509, message: "User cannot like their own comment." };
    }

    // Step 3: Get book_guid from comment
    const book_guid = commentData?.book_guid;
    if (!book_guid) {
      throw { code: 400, message: "Comment is missing book_guid." };
    }

    // Step 4: Get/create the user liked comments document
    // New structure: re_user_liked_comments/{user_guid}_{book_guid}
    const userLikedCommentsDocId = `${user_guid}_${book_guid}`;
    const userLikedCommentsDocRef = admin
      .firestore()
      .collection("re_user_liked_comments")
      .doc(userLikedCommentsDocId);

    const likedDocSnapshot = await transaction.get(userLikedCommentsDocRef);

    let likedCommentOwners: string[] = [];
    let docData: any = {
      book_guid,
      user_guid,
      liked_comment_owners: [],
    };

    if (likedDocSnapshot.exists) {
      const existingData = likedDocSnapshot.data();
      likedCommentOwners = existingData?.liked_comment_owners || [];
      docData = existingData;
    }

    const commentOwnerGuid = commentData.user_guid;
    const isCurrentlyLiked = likedCommentOwners.includes(commentOwnerGuid);

    // Step 5: Handle like/unlike logic
    if (method === "like") {
      // If already liked, throw error
      if (isCurrentlyLiked) {
        throw { code: 510, message: "User has already liked this comment." };
      }

      // Add comment owner to array
      likedCommentOwners.push(commentOwnerGuid);
      
      // Increment num_of_likes
      const currentLikes = commentData.num_of_likes || 0;
      transaction.update(commentDocRef, { num_of_likes: currentLikes + 1 });
    } else {
      // method === "unlike"
      // If not currently liked, throw error
      if (!isCurrentlyLiked) {
        throw { code: 511, message: "User has not liked this comment." };
      }

      // Remove comment owner from array
      likedCommentOwners = likedCommentOwners.filter(owner => owner !== commentOwnerGuid);
      
      // Decrement num_of_likes (ensure it doesn't go below 0)
      const currentLikes = commentData.num_of_likes || 0;
      transaction.update(commentDocRef, { 
        num_of_likes: Math.max(0, currentLikes - 1) 
      });
    }

    // Step 6: Update/create the user liked comments document
    docData.liked_comment_owners = likedCommentOwners;
    transaction.set(userLikedCommentsDocRef, docData);

    return { 
      code: 200, 
      message: method === "like" 
        ? "Comment liked successfully." 
        : "Comment unliked successfully." 
    };
  });
}

/**
 * Core logic for flagging/unflagging a comment
 */
export async function handleFlag(
  comment_guid: string,
  user_guid: string,
  method: "flag" | "unflag"
): Promise<{ code: number; message: string }> {
  if (!comment_guid || typeof comment_guid !== "string" || comment_guid.trim() === "") {
    console.error("Error with comment_guid:", comment_guid);
    throw { code: 400, message: "Invalid comment_guid." };
  }

  if (method !== "flag" && method !== "unflag") {
    throw { code: 400, message: "Invalid method. Must be 'flag' or 'unflag'." };
  }

  // Firestore references
  const commentDocRef = admin.firestore().collection("re_review_content").doc(comment_guid);

  // Use a Firestore transaction
  return await admin.firestore().runTransaction(async (transaction) => {
    // Step 1: Check if the comment exists
    const commentDoc = await transaction.get(commentDocRef);

    if (!commentDoc.exists) {
      throw { code: 508, message: "Comment does not exist." };
    }

    const commentData = commentDoc.data();
    
    // Check if comment is soft-deleted
    if (commentData?.is_deleted === true) {
      throw { code: 508, message: "Comment does not exist." };
    }

    // Step 2: Ensure the user is not the owner of the comment
    if (commentData?.user_guid === user_guid) {
      throw { code: 509, message: "User cannot flag their own comment." };
    }

    // Step 3: Get book_guid from comment
    const book_guid = commentData?.book_guid;
    if (!book_guid) {
      throw { code: 400, message: "Comment is missing book_guid." };
    }

    // Step 4: Get/create the user flagged comments document
    // New structure: re_user_flagged_comments/{user_guid}_{book_guid}
    const userFlaggedCommentsDocId = `${user_guid}_${book_guid}`;
    const userFlaggedCommentsDocRef = admin
      .firestore()
      .collection("re_user_flagged_comments")
      .doc(userFlaggedCommentsDocId);

    const flaggedDocSnapshot = await transaction.get(userFlaggedCommentsDocRef);

    let flaggedCommentOwners: string[] = [];
    let docData: any = {
      book_guid,
      user_guid,
      flagged_comment_owners: [],
    };

    if (flaggedDocSnapshot.exists) {
      const existingData = flaggedDocSnapshot.data();
      flaggedCommentOwners = existingData?.flagged_comment_owners || [];
      docData = existingData;
    }

    const commentOwnerGuid = commentData.user_guid;
    const isCurrentlyFlagged = flaggedCommentOwners.includes(commentOwnerGuid);

    // Step 5: Handle flag/unflag logic
    if (method === "flag") {
      // If already flagged, throw error
      if (isCurrentlyFlagged) {
        throw { code: 510, message: "User has already flagged this comment." };
      }

      // Add comment owner to flagged array
      flaggedCommentOwners.push(commentOwnerGuid);
      
      // Increment num_of_flags
      const currentFlags = commentData.num_of_flags || 0;
      transaction.update(commentDocRef, { num_of_flags: currentFlags + 1 });
    } else {
      // method === "unflag"
      // If not currently flagged, throw error
      if (!isCurrentlyFlagged) {
        throw { code: 511, message: "User has not flagged this comment before" };
      }

      // Remove comment owner from array
      flaggedCommentOwners = flaggedCommentOwners.filter(owner => owner !== commentOwnerGuid);
      
      // Decrement num_of_flags (ensure it doesn't go below 0)
      const currentFlags = commentData.num_of_flags || 0;
      transaction.update(commentDocRef, { 
        num_of_flags: Math.max(0, currentFlags - 1) 
      });
    }

    // Step 6: Update/create the user flagged comments document
    docData.flagged_comment_owners = flaggedCommentOwners;
    transaction.set(userFlaggedCommentsDocRef, docData);

    return { 
      code: 200, 
      message: method === "flag" 
        ? "Comment flagged successfully." 
        : "Comment unflagged successfully." 
    };
  });
}

