import type { ModelMessage } from '@garden/model-gateway';
import { describe, expect, it } from 'vitest';
import {
  haltReason,
  retryTurnHandoff,
  sealUnansweredToolCalls,
  startStopWatch,
  unansweredToolCallIds,
  withPeriodicRenewal,
  withRequestDeadline
} from './turn-lifecycle.js';

describe('unanswered tool calls', () => {
  const assistantWithCalls = (...ids: string[]): ModelMessage => ({
    role: 'assistant',
    content: '',
    toolCalls: ids.map((id) => ({ id, name: 'shell', arguments: {} }))
  });

  it('finds calls that never received a result', () => {
    expect(
      unansweredToolCallIds([
        { role: 'user', content: 'go' },
        assistantWithCalls('call-1', 'call-2'),
        { role: 'tool', toolCallId: 'call-1', content: 'done' }
      ])
    ).toEqual(['call-2']);
  });

  it('treats a fully answered turn as clean', () => {
    expect(
      unansweredToolCallIds([
        assistantWithCalls('call-1'),
        { role: 'tool', toolCallId: 'call-1', content: 'done' }
      ])
    ).toEqual([]);
  });

  it('reports each pending id once even when a call is repeated', () => {
    expect(
      unansweredToolCallIds([assistantWithCalls('call-1'), assistantWithCalls('call-1')])
    ).toEqual(['call-1']);
  });

  it('seals a turn cut short so the next request is not malformed', () => {
    // A provider rejects an assistant message whose tool_calls have no matching results, so a
    // task that finished, paused or was cancelled mid-turn would fail on resume without this.
    const messages: ModelMessage[] = [
      assistantWithCalls('call-1', 'call-2'),
      { role: 'tool', toolCallId: 'call-1', content: 'done' }
    ];
    expect(sealUnansweredToolCalls(messages, 'the task was paused')).toEqual(['call-2']);
    expect(messages).toHaveLength(3);
    expect(messages[2]).toMatchObject({
      role: 'tool',
      toolCallId: 'call-2',
      content: 'Not executed: the task was paused'
    });
    expect(unansweredToolCallIds(messages)).toEqual([]);
  });

  it('leaves an already complete turn untouched', () => {
    const messages: ModelMessage[] = [
      assistantWithCalls('call-1'),
      { role: 'tool', toolCallId: 'call-1', content: 'done' }
    ];
    expect(sealUnansweredToolCalls(messages, 'finished')).toEqual([]);
    expect(messages).toHaveLength(2);
  });
});

describe('completion handoff', () => {
  const recordingSleep = (waits: number[]) => async (milliseconds: number) => {
    waits.push(milliseconds);
  };

  it('stops as soon as the turn hands off', async () => {
    const waits: number[] = [];
    let calls = 0;
    await expect(
      retryTurnHandoff({
        attempt: async () => {
          calls += 1;
          return calls === 2;
        },
        stillOwned: async () => true,
        sleep: recordingSleep(waits)
      })
    ).resolves.toBe('handed_off');
    expect(calls).toBe(2);
    expect(waits).toHaveLength(1);
  });

  it('gives up immediately when the lease is gone instead of spinning a core', async () => {
    const waits: number[] = [];
    await expect(
      retryTurnHandoff({
        attempt: async () => false,
        stillOwned: async () => false,
        sleep: recordingSleep(waits)
      })
    ).resolves.toBe('released');
    expect(waits).toEqual([]);
  });

  it('is bounded rather than an unbounded loop', async () => {
    const waits: number[] = [];
    await expect(
      retryTurnHandoff({
        attempt: async () => false,
        stillOwned: async () => true,
        sleep: recordingSleep(waits),
        attempts: 3,
        delayMs: 10
      })
    ).resolves.toBe('exhausted');
    expect(waits).toEqual([10, 10, 10]);
  });
});

describe('request deadlines and lease renewal', () => {
  it('aborts an operation that outlives its deadline', async () => {
    await expect(
      withRequestDeadline(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason as Error));
          }),
        5
      )
    ).rejects.toMatchObject({ code: 'model_request_timeout' });
  });

  it('passes a live signal through and clears the timer on success', async () => {
    const aborted = await withRequestDeadline(async (signal) => signal.aborted, 60_000);
    expect(aborted).toBe(false);
  });

  it('renews while a long tool runs, and stops renewing once it returns', async () => {
    // The lease is 120 s but a shell tool may run for an hour; without renewal mid-tool another
    // worker can steal the task and run it twice.
    let renewals = 0;
    const result = await withPeriodicRenewal(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return 'finished';
      },
      async () => {
        renewals += 1;
      },
      10
    );
    expect(result).toBe('finished');
    const observed = renewals;
    expect(observed).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(renewals).toBe(observed);
  });

  it('keeps running when a renewal fails', async () => {
    await expect(
      withPeriodicRenewal(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return 'ok';
        },
        async () => {
          throw new Error('lease store unavailable');
        },
        5
      )
    ).resolves.toBe('ok');
  });
});

describe('stopping a model request that is already running', () => {
  it('tells the owner stopping the task apart from losing it to another claimant', () => {
    expect(haltReason({ status: 'running', leaseOwner: 'w1' }, 'w1')).toBeNull();
    expect(haltReason({ status: 'planning', leaseOwner: 'w1' }, 'w1')).toBeNull();
    // The lease is cleared by the pause itself, so a null owner is the ordinary running case.
    expect(haltReason({ status: 'running', leaseOwner: null }, 'w1')).toBeNull();

    expect(haltReason({ status: 'paused', leaseOwner: null }, 'w1')).toBe('stopped');
    expect(haltReason({ status: 'cancelled', leaseOwner: null }, 'w1')).toBe('stopped');

    // Resume sets the status back to queued and clears the lease in one statement, which is exactly
    // how a second worker gets a task this one is still generating. Seeing it means standing down.
    expect(haltReason({ status: 'queued', leaseOwner: null }, 'w1')).toBe('disowned');
    expect(haltReason({ status: 'running', leaseOwner: 'w2' }, 'w1')).toBe('disowned');
    expect(haltReason(null, 'w1')).toBe('disowned');
    // The owner's stop is honoured even when the task has moved on; the caller decides what that
    // means, and the closing write has its own guard.
    expect(haltReason({ status: 'cancelled', leaseOwner: 'w2' }, 'w1')).toBe('stopped');
  });

  it('aborts the request in flight and records why, before the abort lands', async () => {
    let status = 'running';
    const watch = startStopWatch(async () => ({ status, leaseOwner: 'w1' }), 'w1', 5);
    const request = new Promise<string>((_resolve, reject) => {
      watch.signal.addEventListener('abort', () => {
        // The reason has to be readable by the time the request rejects, because a stop that lands
        // before the response headers reaches the caller as an ordinary provider fault.
        reject(new Error(`aborted:${String(watch.halt)}`));
      });
    });
    setTimeout(() => {
      status = 'cancelled';
    }, 10);
    await expect(request).rejects.toThrow('aborted:stopped');
    watch.stop();
  });

  it('leaves a healthy request alone and stops polling once it is over', async () => {
    let reads = 0;
    const watch = startStopWatch(
      async () => {
        reads += 1;
        return { status: 'running', leaseOwner: 'w1' };
      },
      'w1',
      5
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(watch.signal.aborted).toBe(false);
    expect(watch.halt).toBeNull();
    watch.stop();
    const observed = reads;
    expect(observed).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reads).toBe(observed);
  });

  it('survives a database that cannot answer, rather than stopping the task', async () => {
    const watch = startStopWatch(
      async () => {
        throw new Error('database unreachable');
      },
      'w1',
      5
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(watch.signal.aborted).toBe(false);
    expect(watch.halt).toBeNull();
    watch.stop();
  });
});
