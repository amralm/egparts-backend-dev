class FakeClock {
    constructor() {
        this.now = new Date();
    }

    set(date) {
        this.now = new Date(date);
    }

    advanceBy(ms) {
        this.now = new Date(this.now.getTime() + ms);
    }

    getCurrentTime() {
        return this.now;
    }
}

module.exports = FakeClock;
