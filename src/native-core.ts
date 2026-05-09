import { existsSync } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";

export interface ZigCore {
  cdproxy_pick_next_flags(len: number, start: number, unavailableFlags: number): number;
  cdproxy_parse_auth_json(data: number, len: number, out: number): boolean;
  cdproxy_is_terminal_response_event(data: number, len: number): boolean;
  cdproxy_jwt_exp_ms(data: number, len: number): number;
}

export function loadZigCore(path: string, log: (...args: unknown[]) => void): ZigCore | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const lib = dlopen(path, {
      cdproxy_pick_next_flags: { args: [FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
      cdproxy_parse_auth_json: { args: [FFIType.ptr, FFIType.usize, FFIType.ptr], returns: FFIType.bool },
      cdproxy_is_terminal_response_event: { args: [FFIType.ptr, FFIType.usize], returns: FFIType.bool },
      cdproxy_jwt_exp_ms: { args: [FFIType.ptr, FFIType.usize], returns: FFIType.f64 },
    });
    log(`loaded Zig core: ${path}`);
    return lib.symbols as unknown as ZigCore;
  } catch (err) {
    console.error(`warning: failed to load Zig core at ${path}; using JS fallback: ${err}`);
    return undefined;
  }
}
