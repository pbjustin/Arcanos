export class Conversation {
    private history: string[] = []

    addTurn(turn: string) {
        this.history.push(turn)
    }

    getContext() {
        return this.history.slice(-10)
    }
}
