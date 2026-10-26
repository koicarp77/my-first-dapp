import { BaseError as BaseViemError, ContractFunctionRevertedError } from "viem";
import { decodeAbiParameters, parseAbiParameters } from "viem/utils";

/**
 * 有些链（如 POTOS 测试网）对合约 revert 返回非标准 RPC 错误码（code 16、空 message），
 * viem 识别不了，只能显示通用的 "RPC Request failed."，真实原因藏在响应的 data 字段里。
 * 这里从错误链上找到 revert data（0x08c379a0 = Error(string)、0x4e487b71 = Panic）并解码。
 */
const PANIC_CODES: Record<number, string> = {
  0x01: "assertion failed",
  0x11: "arithmetic operation underflowed or overflowed",
  0x12: "division or modulo by zero",
  0x21: "invalid conversion to enum type",
  0x22: "access to incorrectly encoded storage byte array",
  0x31: "pop() on an empty array",
  0x32: "array index out of bounds",
  0x41: "out of memory",
  0x51: "call to a zero-initialized variable of internal function type",
};

const decodeRevertData = (data: string): string | null => {
  if (typeof data !== "string" || !data.startsWith("0x") || data.length < 10) return null;
  try {
    if (data.startsWith("0x08c379a0")) {
      const [reason] = decodeAbiParameters(parseAbiParameters("string"), `0x${data.slice(10)}`);
      return reason;
    }
    if (data.startsWith("0x4e487b71")) {
      const [code] = decodeAbiParameters(parseAbiParameters("uint256"), `0x${data.slice(10)}`);
      return `Panic(${code})${PANIC_CODES[Number(code)] ? `: ${PANIC_CODES[Number(code)]}` : ""}`;
    }
  } catch {
    // 不是可解码的 revert data，忽略
  }
  return null;
};

const getRevertReasonFromErrorChain = (error: any): string | null => {
  let current = error;
  let depth = 0;
  while (current && typeof current === "object" && depth < 10) {
    if (typeof current.data === "string" && current.data.startsWith("0x")) {
      const decoded = decodeRevertData(current.data);
      if (decoded) {
        return `Contract function execution reverted with the following reason:\n${decoded}`;
      }
    }
    current = current.cause;
    depth++;
  }
  return null;
};

/**
 * Parses an viem/wagmi error to get a displayable string
 * @param e - error object
 * @returns parsed error string
 */
export const getParsedError = (error: any): string => {
  // 先尝试从错误链上的 revert data 解码出真实原因（见上方注释）
  const revertReason = getRevertReasonFromErrorChain(error);
  if (revertReason) return revertReason;

  const parsedError = error?.walk ? error.walk() : error;

  if (parsedError instanceof BaseViemError) {
    if (parsedError.details) {
      return parsedError.details;
    }

    if (parsedError.shortMessage) {
      if (parsedError instanceof ContractFunctionRevertedError && parsedError.data) {
        if (parsedError.data.errorName !== "Error") {
          const customErrorArgs = parsedError.data.args?.toString() ?? "";
          return `${parsedError.shortMessage.replace(/reverted\.$/, "reverted with the following reason:")}\n${
            parsedError.data.errorName
          }(${customErrorArgs})`;
        }

        // Error(string)：把 require 的文案显示出来（标准链上走这个分支）
        const reason = parsedError.data.args?.[0];
        if (typeof reason === "string" && reason.length > 0) {
          return `Contract function execution reverted with the following reason:\n${reason}`;
        }
      }

      return parsedError.shortMessage;
    }

    return parsedError.message ?? parsedError.name ?? "An unknown error occurred";
  }

  return parsedError?.message ?? "An unknown error occurred";
};
