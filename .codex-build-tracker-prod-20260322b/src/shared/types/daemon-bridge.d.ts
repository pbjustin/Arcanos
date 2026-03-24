declare module '../../daemon/bridge.js' {
  export const bridge: {
    active: boolean;
    assignTag?: (reqId: string) => string;
    routeRequest: (payload: unknown) => void;
  };

  export function startBridgeServer(): unknown;
}
