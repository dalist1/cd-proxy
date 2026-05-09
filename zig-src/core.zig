const std = @import("std");

/// Pick the next available credential using a byte flag array.
///
/// `unavailable_flags[i] != 0` means index i must be skipped. Unlike the u32
/// mask helper this supports any credential count and keeps the wrap/skip scan
/// in one FFI call.
export fn cdproxy_pick_next_flags(len: u32, start: u32, unavailable_flags: [*]const u8) i32 {
    if (len == 0 or len > 1_000_000) return -1;
    const s = start % len;
    var i: u32 = 0;
    while (i < len) : (i += 1) {
        const idx = (s + i) % len;
        if (unavailable_flags[idx] == 0) return @intCast(idx);
    }
    return -1;
}

const AuthJsonView = extern struct {
    type_start: usize,
    type_len: usize,
    email_start: usize,
    email_len: usize,
    account_id_start: usize,
    account_id_len: usize,
    access_token_start: usize,
    access_token_len: usize,
    refresh_token_start: usize,
    refresh_token_len: usize,
    id_token_start: usize,
    id_token_len: usize,
    expired_start: usize,
    expired_len: usize,
    last_refresh_start: usize,
    last_refresh_len: usize,
    disabled: u8,
};

const ParsedString = struct {
    start: usize,
    end: usize,
    escaped: bool,
};

fn skipWs(bytes: []const u8, idx: *usize) void {
    while (idx.* < bytes.len) : (idx.* += 1) {
        switch (bytes[idx.*]) {
            ' ', '\n', '\r', '\t' => {},
            else => return,
        }
    }
}

fn parseJsonString(bytes: []const u8, idx: *usize) ?ParsedString {
    if (idx.* >= bytes.len or bytes[idx.*] != '"') return null;
    var i = idx.* + 1;
    const start = i;
    var escaped = false;
    while (i < bytes.len) : (i += 1) {
        switch (bytes[i]) {
            '"' => {
                const parsed = ParsedString{ .start = start, .end = i, .escaped = escaped };
                idx.* = i + 1;
                return parsed;
            },
            '\\' => {
                escaped = true;
                i += 1;
                if (i >= bytes.len) return null;
            },
            else => {},
        }
    }
    return null;
}

fn parsedStringEquals(bytes: []const u8, parsed: ParsedString, lit: []const u8) bool {
    return !parsed.escaped and std.mem.eql(u8, bytes[parsed.start..parsed.end], lit);
}

fn setStringPair(start: *usize, len: *usize, parsed: ParsedString) void {
    start.* = parsed.start;
    len.* = parsed.end - parsed.start;
}

fn skipCompoundJsonValue(bytes: []const u8, idx: *usize) bool {
    var i = idx.*;
    if (i >= bytes.len) return false;
    var depth: usize = 0;
    while (i < bytes.len) {
        switch (bytes[i]) {
            '"' => {
                var str_i = i;
                _ = parseJsonString(bytes, &str_i) orelse return false;
                i = str_i;
            },
            '{', '[' => {
                depth += 1;
                i += 1;
            },
            '}', ']' => {
                if (depth == 0) return false;
                depth -= 1;
                i += 1;
                if (depth == 0) {
                    idx.* = i;
                    return true;
                }
            },
            else => i += 1,
        }
    }
    return false;
}

fn skipJsonValue(bytes: []const u8, idx: *usize) bool {
    skipWs(bytes, idx);
    if (idx.* >= bytes.len) return false;
    switch (bytes[idx.*]) {
        '"' => return parseJsonString(bytes, idx) != null,
        '{', '[' => return skipCompoundJsonValue(bytes, idx),
        else => {
            const start = idx.*;
            while (idx.* < bytes.len) : (idx.* += 1) {
                switch (bytes[idx.*]) {
                    ',', '}', ']', ' ', '\n', '\r', '\t' => break,
                    else => {},
                }
            }
            return idx.* > start;
        },
    }
}

fn parseJsonBool(bytes: []const u8, idx: *usize) ?bool {
    if (std.mem.startsWith(u8, bytes[idx.*..], "true")) {
        idx.* += 4;
        return true;
    }
    if (std.mem.startsWith(u8, bytes[idx.*..], "false")) {
        idx.* += 5;
        return false;
    }
    return null;
}

fn isTerminalResponseType(value: []const u8) bool {
    return std.mem.eql(u8, value, "response.completed") or
        std.mem.eql(u8, value, "response.done") or
        std.mem.eql(u8, value, "response.incomplete");
}

fn jsonRootStringFieldIsTerminalType(bytes: []const u8) bool {
    var i: usize = 0;
    skipWs(bytes, &i);
    if (i >= bytes.len or bytes[i] != '{') return false;
    i += 1;

    while (i < bytes.len) {
        skipWs(bytes, &i);
        if (i >= bytes.len or bytes[i] == '}') return false;

        const key = parseJsonString(bytes, &i) orelse return false;
        skipWs(bytes, &i);
        if (i >= bytes.len or bytes[i] != ':') return false;
        i += 1;
        skipWs(bytes, &i);

        if (parsedStringEquals(bytes, key, "type")) {
            const value = parseJsonString(bytes, &i) orelse return false;
            return !value.escaped and isTerminalResponseType(bytes[value.start..value.end]);
        }

        if (!skipJsonValue(bytes, &i)) return false;
        skipWs(bytes, &i);
        if (i < bytes.len and bytes[i] == ',') {
            i += 1;
            continue;
        }
        if (i < bytes.len and bytes[i] == '}') return false;
    }
    return false;
}

/// Parse a cd-proxy Codex auth JSON file into string offsets owned by `data`.
///
/// The TypeScript side uses those offsets to slice strings without a full
/// JS JSON.parse on the auth load/reload path. We intentionally require known
/// string fields to be unescaped; escaped or unusual auth files fall back to JS.
export fn cdproxy_parse_auth_json(data: [*]const u8, len: usize, out: *AuthJsonView) bool {
    if (len == 0 or len > 1024 * 1024) return false;
    const bytes = data[0..len];
    out.* = std.mem.zeroes(AuthJsonView);

    var i: usize = 0;
    var closed = false;
    skipWs(bytes, &i);
    if (i >= bytes.len or bytes[i] != '{') return false;
    i += 1;

    while (i < bytes.len) {
        skipWs(bytes, &i);
        if (i < bytes.len and bytes[i] == '}') {
            i += 1;
            closed = true;
            break;
        }

        const key = parseJsonString(bytes, &i) orelse return false;
        if (key.escaped) return false;
        const key_bytes = bytes[key.start..key.end];
        skipWs(bytes, &i);
        if (i >= bytes.len or bytes[i] != ':') return false;
        i += 1;
        skipWs(bytes, &i);

        if (std.mem.eql(u8, key_bytes, "type")) {
            const value = parseJsonString(bytes, &i) orelse return false;
            if (value.escaped) return false;
            setStringPair(&out.type_start, &out.type_len, value);
        } else if (std.mem.eql(u8, key_bytes, "email")) {
            const value = parseJsonString(bytes, &i) orelse return false;
            if (value.escaped) return false;
            setStringPair(&out.email_start, &out.email_len, value);
        } else if (std.mem.eql(u8, key_bytes, "account_id")) {
            const value = parseJsonString(bytes, &i) orelse return false;
            if (value.escaped) return false;
            setStringPair(&out.account_id_start, &out.account_id_len, value);
        } else if (std.mem.eql(u8, key_bytes, "access_token")) {
            const value = parseJsonString(bytes, &i) orelse return false;
            if (value.escaped) return false;
            setStringPair(&out.access_token_start, &out.access_token_len, value);
        } else if (std.mem.eql(u8, key_bytes, "refresh_token")) {
            const value = parseJsonString(bytes, &i) orelse return false;
            if (value.escaped) return false;
            setStringPair(&out.refresh_token_start, &out.refresh_token_len, value);
        } else if (std.mem.eql(u8, key_bytes, "id_token")) {
            const value = parseJsonString(bytes, &i) orelse return false;
            if (value.escaped) return false;
            setStringPair(&out.id_token_start, &out.id_token_len, value);
        } else if (std.mem.eql(u8, key_bytes, "expired")) {
            const value = parseJsonString(bytes, &i) orelse return false;
            if (value.escaped) return false;
            setStringPair(&out.expired_start, &out.expired_len, value);
        } else if (std.mem.eql(u8, key_bytes, "last_refresh")) {
            const value = parseJsonString(bytes, &i) orelse return false;
            if (value.escaped) return false;
            setStringPair(&out.last_refresh_start, &out.last_refresh_len, value);
        } else if (std.mem.eql(u8, key_bytes, "disabled")) {
            out.disabled = if (parseJsonBool(bytes, &i) orelse return false) 1 else 0;
        } else if (!skipJsonValue(bytes, &i)) {
            return false;
        }

        skipWs(bytes, &i);
        if (i < bytes.len and bytes[i] == ',') {
            i += 1;
            continue;
        }
        if (i < bytes.len and bytes[i] == '}') {
            i += 1;
            closed = true;
            break;
        }
        return false;
    }

    skipWs(bytes, &i);
    return closed and i == bytes.len and out.access_token_start != 0 and out.refresh_token_start != 0;
}

/// Fast terminal Responses WebSocket event detection for Bun FFI.
///
/// This intentionally parses only enough top-level JSON to read the root
/// `type` string. It replaces a JS JSON.parse on every upstream WebSocket
/// frame while keeping the JS implementation as a fallback.
export fn cdproxy_is_terminal_response_event(data: [*]const u8, len: usize) bool {
    if (len == 0 or len > 1024 * 1024) return false;
    return jsonRootStringFieldIsTerminalType(data[0..len]);
}

fn b64urlVal(c: u8) ?u8 {
    return switch (c) {
        'A'...'Z' => c - 'A',
        'a'...'z' => c - 'a' + 26,
        '0'...'9' => c - '0' + 52,
        '-' => 62,
        '_' => 63,
        else => null,
    };
}

fn decodeBase64Url(input: []const u8, output: []u8) ?usize {
    var acc: u32 = 0;
    var bits: u32 = 0;
    var out_len: usize = 0;

    for (input) |c| {
        if (c == '=') break;
        const v = b64urlVal(c) orelse return null;
        acc = (acc << 6) | @as(u32, v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (out_len >= output.len) return null;
            const shift: u5 = @intCast(bits);
            output[out_len] = @truncate(acc >> shift);
            out_len += 1;
            if (bits == 0) {
                acc = 0;
            } else {
                const mask = (@as(u32, 1) << @as(u5, @intCast(bits))) - 1;
                acc &= mask;
            }
        }
    }

    return out_len;
}

fn parseJsonNumber(bytes: []const u8, idx: *usize) ?f64 {
    skipWs(bytes, idx);
    const start = idx.*;
    if (idx.* < bytes.len and bytes[idx.*] == '-') idx.* += 1;
    var saw_digit = false;
    while (idx.* < bytes.len and bytes[idx.*] >= '0' and bytes[idx.*] <= '9') : (idx.* += 1) saw_digit = true;
    if (idx.* < bytes.len and bytes[idx.*] == '.') {
        idx.* += 1;
        while (idx.* < bytes.len and bytes[idx.*] >= '0' and bytes[idx.*] <= '9') : (idx.* += 1) saw_digit = true;
    }
    if (idx.* < bytes.len and (bytes[idx.*] == 'e' or bytes[idx.*] == 'E')) {
        idx.* += 1;
        if (idx.* < bytes.len and (bytes[idx.*] == '+' or bytes[idx.*] == '-')) idx.* += 1;
        var exp_digits = false;
        while (idx.* < bytes.len and bytes[idx.*] >= '0' and bytes[idx.*] <= '9') : (idx.* += 1) exp_digits = true;
        if (!exp_digits) return null;
    }
    if (!saw_digit or idx.* <= start) return null;
    return std.fmt.parseFloat(f64, bytes[start..idx.*]) catch null;
}

fn jsonRootNumberField(bytes: []const u8, field: []const u8) ?f64 {
    var i: usize = 0;
    skipWs(bytes, &i);
    if (i >= bytes.len or bytes[i] != '{') return null;
    i += 1;

    while (i < bytes.len) {
        skipWs(bytes, &i);
        if (i >= bytes.len or bytes[i] == '}') return null;

        const key = parseJsonString(bytes, &i) orelse return null;
        skipWs(bytes, &i);
        if (i >= bytes.len or bytes[i] != ':') return null;
        i += 1;
        skipWs(bytes, &i);

        if (parsedStringEquals(bytes, key, field)) {
            return parseJsonNumber(bytes, &i);
        }

        if (!skipJsonValue(bytes, &i)) return null;
        skipWs(bytes, &i);
        if (i < bytes.len and bytes[i] == ',') {
            i += 1;
            continue;
        }
        if (i < bytes.len and bytes[i] == '}') return null;
    }
    return null;
}

/// Decode a JWT payload and return its numeric `exp` claim in milliseconds.
/// Returns 0 when the token is malformed or has no usable exp claim.
export fn cdproxy_jwt_exp_ms(data: [*]const u8, len: usize) f64 {
    if (len == 0 or len > 256 * 1024) return 0;
    const token = data[0..len];
    const first_dot = std.mem.indexOfScalar(u8, token, '.') orelse return 0;
    const rest = token[first_dot + 1 ..];
    const second_dot_rel = std.mem.indexOfScalar(u8, rest, '.') orelse return 0;
    const payload = rest[0..second_dot_rel];
    if (payload.len == 0) return 0;

    var decoded_buf: [64 * 1024]u8 = undefined;
    const decoded_len = decodeBase64Url(payload, decoded_buf[0..]) orelse return 0;
    const exp_seconds = jsonRootNumberField(decoded_buf[0..decoded_len], "exp") orelse return 0;
    if (exp_seconds <= 0) return 0;
    return exp_seconds * 1000.0;
}

test "pick_next_flags supports larger flag arrays" {
    var unavailable = [_]u8{0} ** 40;
    unavailable[38] = 1;
    try std.testing.expectEqual(@as(i32, 39), cdproxy_pick_next_flags(40, 38, unavailable[0..].ptr));
    unavailable[39] = 1;
    try std.testing.expectEqual(@as(i32, 0), cdproxy_pick_next_flags(40, 38, unavailable[0..].ptr));
    for (&unavailable) |*flag| flag.* = 1;
    try std.testing.expectEqual(@as(i32, -1), cdproxy_pick_next_flags(40, 38, unavailable[0..].ptr));
}

test "auth json parser extracts expected fields" {
    const json =
        \\{
        \\  "type": "codex",
        \\  "email": "a@example.test",
        \\  "account_id": "acct-1",
        \\  "access_token": "access",
        \\  "refresh_token": "refresh",
        \\  "id_token": "id",
        \\  "expired": "2099-01-01T00:00:00Z",
        \\  "last_refresh": "2026-01-01T00:00:00Z",
        \\  "disabled": true,
        \\  "unknown": { "nested": [1, 2, 3] }
        \\}
    ;
    var out: AuthJsonView = undefined;
    try std.testing.expect(cdproxy_parse_auth_json(json.ptr, json.len, &out));
    try std.testing.expectEqualStrings("codex", json[out.type_start..][0..out.type_len]);
    try std.testing.expectEqualStrings("a@example.test", json[out.email_start..][0..out.email_len]);
    try std.testing.expectEqualStrings("acct-1", json[out.account_id_start..][0..out.account_id_len]);
    try std.testing.expectEqualStrings("access", json[out.access_token_start..][0..out.access_token_len]);
    try std.testing.expectEqualStrings("refresh", json[out.refresh_token_start..][0..out.refresh_token_len]);
    try std.testing.expectEqualStrings("id", json[out.id_token_start..][0..out.id_token_len]);
    try std.testing.expectEqualStrings("2099-01-01T00:00:00Z", json[out.expired_start..][0..out.expired_len]);
    try std.testing.expectEqualStrings("2026-01-01T00:00:00Z", json[out.last_refresh_start..][0..out.last_refresh_len]);
    try std.testing.expectEqual(@as(u8, 1), out.disabled);
}

test "auth json parser rejects escaped known strings for JS fallback" {
    const json = "{\"access_token\":\"access\",\"refresh_token\":\"refresh\",\"email\":\"a\\u0040b\"}";
    var out: AuthJsonView = undefined;
    try std.testing.expect(!cdproxy_parse_auth_json(json.ptr, json.len, &out));
}

test "auth json parser rejects trailing garbage" {
    const json = "{\"access_token\":\"access\",\"refresh_token\":\"refresh\"} nope";
    var out: AuthJsonView = undefined;
    try std.testing.expect(!cdproxy_parse_auth_json(json.ptr, json.len, &out));
}

test "terminal websocket event detection" {
    const completed = "{\"type\":\"response.completed\"}";
    const done_later = "{\"x\":1,\"type\":\"response.done\"}";
    const incomplete = " { \"type\" : \"response.incomplete\", \"x\": [1,2,3] }";
    const nested_only = "{\"x\":{\"type\":\"response.completed\"}}";
    const nonterminal = "{\"type\":\"response.output_text.delta\"}";

    try std.testing.expect(cdproxy_is_terminal_response_event(completed.ptr, completed.len));
    try std.testing.expect(cdproxy_is_terminal_response_event(done_later.ptr, done_later.len));
    try std.testing.expect(cdproxy_is_terminal_response_event(incomplete.ptr, incomplete.len));
    try std.testing.expect(!cdproxy_is_terminal_response_event(nested_only.ptr, nested_only.len));
    try std.testing.expect(!cdproxy_is_terminal_response_event(nonterminal.ptr, nonterminal.len));
}

test "jwt exp decoder" {
    const token = "aaa.eyJleHAiOjEyMzQ1fQ.sig";
    try std.testing.expectEqual(@as(f64, 12345000.0), cdproxy_jwt_exp_ms(token.ptr, token.len));

    const no_exp = "aaa.e30.sig";
    try std.testing.expectEqual(@as(f64, 0), cdproxy_jwt_exp_ms(no_exp.ptr, no_exp.len));
}
