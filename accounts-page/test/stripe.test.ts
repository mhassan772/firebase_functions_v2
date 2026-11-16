import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = () => void;

/// A stand-in for Stripe.js that records the listeners the card form attaches, so a test can fire
/// `ready` and `update-end` when it chooses.
const fake = vi.hoisted(() => {
  const elementHandlers = new Map<string, Handler>();
  const groupHandlers = new Map<string, Handler>();
  const element = {
    on: (event: string, handler: Handler) => elementHandlers.set(event, handler),
    mount: () => undefined,
    destroy: () => undefined,
  };
  const elements = {
    create: () => element,
    on: (event: string, handler: Handler) => groupHandlers.set(event, handler),
    update: () => undefined,
  };
  return { elementHandlers, groupHandlers, stripe: { elements: () => elements } };
});

vi.mock("@stripe/stripe-js/pure", () => ({ loadStripe: async () => fake.stripe }));

import { destroyPayment, mountPayment, updatePayment, type CardFormStatus } from "../src/billing/stripe";

async function mounted(statuses: CardFormStatus[]) {
  const payment = await mountPayment({
    publishableKey: "pk_test_fake",
    lang: "ar",
    kind: "subscription",
    amount: 4999,
    currency: "usd",
    host: {} as HTMLElement,
    onStatus: (status) => statuses.push(status),
  });
  fake.elementHandlers.get("ready")!();
  return payment;
}

describe("the card form's loading status", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reads loading from the mount until Stripe's ready", async () => {
    const statuses: CardFormStatus[] = [];
    await mounted(statuses);
    expect(statuses).toEqual(["loading", "ready"]);
  });

  it("says nothing for an update Stripe applies at once", async () => {
    const statuses: CardFormStatus[] = [];
    const payment = await mounted(statuses);
    updatePayment(payment, "payment", 14999, "usd");
    vi.advanceTimersByTime(100);
    fake.groupHandlers.get("update-end")!();
    vi.advanceTimersByTime(20_000);
    expect(statuses).toEqual(["loading", "ready"]);
  });

  it("shows a slow update as loading, then ready", async () => {
    const statuses: CardFormStatus[] = [];
    const payment = await mounted(statuses);
    updatePayment(payment, "payment", 14999, "usd");
    vi.advanceTimersByTime(150);
    expect(statuses.at(-1)).toBe("loading");
    fake.groupHandlers.get("update-end")!();
    expect(statuses.at(-1)).toBe("ready");
  });

  it("turns the line off when a second change lands while the first one's line is up", async () => {
    const statuses: CardFormStatus[] = [];
    const payment = await mounted(statuses);
    updatePayment(payment, "payment", 14999, "usd");
    vi.advanceTimersByTime(150);
    expect(statuses.at(-1)).toBe("loading");
    // The second change finishes inside the delay: it must still end the line it inherited.
    updatePayment(payment, "subscription", 499, "usd");
    vi.advanceTimersByTime(50);
    fake.groupHandlers.get("update-end")!();
    expect(statuses.at(-1)).toBe("ready");
    vi.advanceTimersByTime(20_000);
    expect(statuses.at(-1)).toBe("ready");
  });

  it("gives up on a missing update-end, and a destroyed form reports nothing more", async () => {
    const statuses: CardFormStatus[] = [];
    const payment = await mounted(statuses);
    updatePayment(payment, "payment", 14999, "usd");
    vi.advanceTimersByTime(10_000);
    expect(statuses.at(-1)).toBe("ready");
    updatePayment(payment, "subscription", 499, "usd");
    const before = statuses.length;
    destroyPayment(payment);
    vi.advanceTimersByTime(20_000);
    expect(statuses.length).toBe(before);
  });
});
