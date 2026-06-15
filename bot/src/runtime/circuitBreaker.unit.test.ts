import { describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from './circuitBreaker.js';

describe('CircuitBreaker', () => {
  it('starts closed and stays closed on success', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.assertCanProceed();
    cb.onSuccess();
    expect(cb.getState()).toBe('closed');
  });

  it('trips open after reaching the failure threshold', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.onFailure();
    cb.onFailure();
    expect(cb.getState()).toBe('closed');
    cb.onFailure();
    expect(cb.getState()).toBe('open');
    expect(() => cb.assertCanProceed()).toThrow(CircuitOpenError);
  });

  it('moves to half-open after cooldown and closes on a successful probe', () => {
    let t = 1000;
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100, now: () => t });
    cb.onFailure();
    expect(cb.getState()).toBe('open');
    t += 50;
    expect(() => cb.assertCanProceed()).toThrow(CircuitOpenError);
    t += 60; // total 110 >= cooldown
    expect(cb.getState()).toBe('half-open');
    cb.assertCanProceed(); // probe allowed
    cb.onSuccess();
    expect(cb.getState()).toBe('closed');
  });

  it('re-opens immediately if the half-open probe fails', () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100, now: () => t });
    cb.onFailure();
    t += 150;
    expect(cb.getState()).toBe('half-open');
    cb.assertCanProceed();
    cb.onFailure();
    expect(cb.getState()).toBe('open');
  });

  it('reports retryAfter on the error', () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100, now: () => t });
    cb.onFailure();
    t += 30;
    try {
      cb.assertCanProceed();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitOpenError);
      expect((err as CircuitOpenError).retryAfterMs).toBe(70);
    }
  });
});
