import { expect, test, vi } from "vitest"
import { withCleanup, createLiveFixture } from "@tests/support/live"
import { Id } from "@be/lib/event-sourcing/event"
import { Pool } from "pg"

test("cleanup attempts every action and preserves the original failure", async () => {
  const original = new Error("scenario failed")
  const cleanupFailure = new Error("cleanup failed")
  const finish = vi.fn(async () => {})
  const promise = withCleanup(
    async () => {
      throw original
    },
    [
      async () => {
        throw cleanupFailure
      },
      finish,
    ],
    "teardown"
  )
  await expect(promise).rejects.toMatchObject({ errors: [original, cleanupFailure], cause: original })
  expect(finish).toHaveBeenCalledOnce()
})

test("successful actions cannot hide cleanup failures", async () => {
  await expect(
    withCleanup(
      async () => 42,
      [
        async () => {
          throw new Error("failed cleanup")
        },
      ],
      "teardown"
    )
  ).rejects.toThrow("teardown")
  expect(await withCleanup(async () => 42, [async () => {}], "teardown")).toBe(42)
})

test("fixture construction never connects, cleanup visits every note and closes its pool", async () => {
  const connect = vi.spyOn(Pool.prototype, "connect")
  const end = vi.spyOn(Pool.prototype, "end").mockImplementation(async () => {})
  const fixture = createLiveFixture()
  expect(connect).not.toHaveBeenCalled()
  fixture.beginCase("cleanup")
  fixture.trackNote(new Id("one"))
  fixture.trackNote(new Id("two"))
  const call = vi
    .spyOn(fixture, "call")
    .mockRejectedValueOnce(new Error("first delete failed"))
    .mockResolvedValueOnce({})
  await expect(
    withCleanup(async () => undefined, [() => fixture.finishCase(), () => fixture.close()], "teardown")
  ).rejects.toThrow("teardown")
  expect(call).toHaveBeenCalledTimes(2)
  expect(end).toHaveBeenCalledTimes(1)
  await fixture.close()
  expect(end).toHaveBeenCalledTimes(1)
})

test("subscription state is restored even when the scenario fails", async () => {
  const fixture = createLiveFixture()
  vi.spyOn(fixture, "subscription").mockResolvedValue({ id: "projection", state: "running" })
  const restore = vi.spyOn(fixture, "setSubscriptionState").mockResolvedValue()
  const original = new Error("scenario failed")
  await expect(
    fixture.withRestoredSubscription("projection", async () => {
      throw original
    })
  ).rejects.toBe(original)
  expect(restore).toHaveBeenCalledWith("projection", "running")
  await fixture.close()
})
