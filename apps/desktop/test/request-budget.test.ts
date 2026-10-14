import { expect, it } from 'vitest';
import { budgeted, foreground, RequestBudget } from '../src/request-budget';

function clock() {
  let now = 0;
  const waits: number[] = [];
  return {
    now: () => now,
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
  };
}

it('holds background requests at the limit minus the reserve, and lets the window use it', async () => {
  const time = clock();
  const budget = new RequestBudget(10, 3, time.now, time.sleep);
  for (let index = 0; index < 7; index++) await budget.take(false);
  expect(time.waits).toEqual([]);
  // The window still has its reserve.
  for (let index = 0; index < 3; index++) await budget.take(true);
  expect(time.waits).toEqual([]);
  // Background work now waits for the oldest request to be a minute old.
  await budget.take(false);
  expect(time.waits).toEqual([60_000]);
});

it('never sends more than the limit in any minute', async () => {
  const time = clock();
  const budget = new RequestBudget(5, 1, time.now, time.sleep);
  const sent: number[] = [];
  for (let index = 0; index < 23; index++) {
    await budget.take(index % 3 === 0);
    sent.push(time.now());
  }
  for (const at of sent)
    expect(sent.filter((t) => t > at - 60_000 && t <= at).length).toBeLessThanOrEqual(5);
});

it('marks requests made for the window as foreground', async () => {
  const seen: boolean[] = [];
  const budget = { take: async (inForeground: boolean) => void seen.push(inForeground) };
  const transport = budgeted(async () => 'ok', budget as unknown as RequestBudget);
  await transport('/a');
  await foreground.run(true, () => transport('/b'));
  expect(seen).toEqual([false, true]);
});
