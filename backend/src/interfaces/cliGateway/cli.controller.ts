import { Orchestrator } from "../../core/orchestration/orchestrator"

export class CLIGatewayController {
    constructor(private readonly orchestrator: Orchestrator) { }

    async escalate(req: any) {
        return this.orchestrator.handleEscalation(req.body)
    }

    async retrieveMemory(req: any) {
        // call memory service
    }

    async writeMemory(req: any) {
        // call memory service
    }
}
