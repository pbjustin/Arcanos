export class InvocationBudget {
  private count = 0;

  constructor(private max: number) {}

  increment() {
    this.count++;
    if (this.count > this.max) {
      throw new Error("Model invocation budget exceeded");
    }
  }
}
