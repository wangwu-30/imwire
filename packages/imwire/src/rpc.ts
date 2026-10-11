export class RpcFail extends Error {
  readonly rpcCode: number;
  readonly data?: unknown;

  constructor(rpcCode: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcFail";
    this.rpcCode = rpcCode;
    this.data = data;
  }
}

export const RPC_PARSE = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL = -32603;
export const RPC_APP = -32000;
