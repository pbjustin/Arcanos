export class Watchdog {
  private start = Date.now();
  private limit = 28000;

  check() {
    if (Date.now() - this.start > this.limit) {
      throw new Error("Execution exceeded watchdog threshold");
    }
  }
}
