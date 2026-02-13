import { Semaphore } from "async-mutex";

export const tierLimits = {
  simple: new Semaphore(100),
  complex: new Semaphore(40),
  critical: new Semaphore(10)
};
