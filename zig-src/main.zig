const std = @import("std");

const DEFAULT_CHATGPT_CODEX_BASE = "https://chatgpt.com/backend-api/codex";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const CodexAuthJson = struct {
    type: ?[]const u8 = null,
    email: ?[]const u8 = null,
    account_id: ?[]const u8 = null,
    access_token: []const u8,
    refresh_token: []const u8,
    id_token: ?[]const u8 = null,
    expired: ?[]const u8 = null,
    last_refresh: ?[]const u8 = null,
    disabled: bool = false,
};

const TokenJson = struct {
    access_token: ?[]const u8 = null,
    refresh_token: ?[]const u8 = null,
    id_token: ?[]const u8 = null,
    expires_in: ?i64 = null,
    @"error": ?[]const u8 = null,
    error_description: ?[]const u8 = null,
};

const AuthEntry = struct {
    path: []const u8,
    label: []const u8,
    data: CodexAuthJson,
    cooling_until_ms: i64 = 0,
};

const Config = struct {
    home: []const u8,
    host: []const u8,
    port: u16,
    auth_dir: []const u8,
    api_key_file: []const u8,
    api_key_env: ?[]const u8,
    upstream_base: []const u8,
    cooldown_ms: i64,
    max_retry_credentials: usize,
    expose_rotation_headers: bool,
    debug: bool,
    models: []const []const u8,
};

const Stats = struct {
    responses_http_requests: u64 = 0,
    responses_websocket_upgrades: u64 = 0,
    responses_websocket_upstream_opens: u64 = 0,
    responses_websocket_terminal_events: u64 = 0,
};

const State = struct {
    gpa: std.mem.Allocator,
    io: std.Io,
    config: Config,
    auth_arena: std.heap.ArenaAllocator,
    auths: []AuthEntry = &.{},
    rr: usize = 0,
    last_chosen_path: ?[]const u8 = null,
    api_key: ?[]const u8 = null,
    stats: Stats = .{},
    http_client: std.http.Client,

    fn enabledCount(s: *const State) usize {
        var n: usize = 0;
        for (s.auths) |a| {
            if (!a.data.disabled) n += 1;
        }
        return n;
    }
};

fn log(state: *const State, comptime fmt: []const u8, args: anytype) void {
    if (state.config.debug) std.debug.print(fmt ++ "\n", args);
}

fn envBool(env: anytype, name: []const u8) bool {
    const v = env.get(name) orelse return false;
    return std.mem.eql(u8, v, "1") or std.ascii.eqlIgnoreCase(v, "true");
}

fn envInt(comptime T: type, env: anytype, name: []const u8, default: T) T {
    const v = env.get(name) orelse return default;
    return std.fmt.parseInt(T, v, 10) catch default;
}

fn expandHome(allocator: std.mem.Allocator, input: []const u8, home: []const u8) ![]const u8 {
    if (std.mem.eql(u8, input, "~")) return allocator.dupe(u8, home);
    if (std.mem.startsWith(u8, input, "~/")) return std.fmt.allocPrint(allocator, "{s}{s}", .{ home, input[1..] });
    return allocator.dupe(u8, input);
}

fn splitCsv(allocator: std.mem.Allocator, raw: []const u8) ![]const []const u8 {
    var list: std.ArrayList([]const u8) = .empty;
    var it = std.mem.splitScalar(u8, raw, ',');
    while (it.next()) |part| {
        const trimmed = std.mem.trim(u8, part, " \t\r\n");
        if (trimmed.len != 0) try list.append(allocator, try allocator.dupe(u8, trimmed));
    }
    return list.toOwnedSlice(allocator);
}

fn readTextFileAlloc(io: std.Io, allocator: std.mem.Allocator, absolute_path: []const u8, limit: usize) ![]u8 {
    var file = try std.Io.Dir.openFileAbsolute(io, absolute_path, .{});
    defer file.close(io);
    var buf: [8192]u8 = undefined;
    var r = file.reader(io, &buf);
    return try r.interface.allocRemaining(allocator, .limited(limit));
}

fn loadApiKey(state: *State) !void {
    if (state.config.api_key_env) |v| {
        const trimmed = std.mem.trim(u8, v, " \t\r\n");
        state.api_key = if (trimmed.len == 0) null else try state.gpa.dupe(u8, trimmed);
        return;
    }
    const raw = readTextFileAlloc(state.io, state.gpa, state.config.api_key_file, 64 * 1024) catch {
        state.api_key = null;
        return;
    };
    defer state.gpa.free(raw);
    const trimmed = std.mem.trim(u8, raw, " \t\r\n");
    state.api_key = if (trimmed.len == 0) null else try state.gpa.dupe(u8, trimmed);
}

fn jsonString(obj: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const v = obj.get(key) orelse return null;
    return switch (v) { .string => |s| s, else => null };
}

fn jsonBool(obj: std.json.ObjectMap, key: []const u8) bool {
    const v = obj.get(key) orelse return false;
    return switch (v) { .bool => |b| b, else => false };
}

fn oldCooling(old_auths: []const AuthEntry, path: []const u8) i64 {
    for (old_auths) |a| if (std.mem.eql(u8, a.path, path)) return a.cooling_until_ms;
    return 0;
}

fn authLess(_: void, a: AuthEntry, b: AuthEntry) bool {
    return std.mem.lessThan(u8, a.path, b.path);
}

fn authIndexByPath(auths: []const AuthEntry, path: []const u8) ?usize {
    for (auths, 0..) |a, i| {
        if (std.mem.eql(u8, a.path, path)) return i;
    }
    return null;
}

fn loadAuths(state: *State) !void {
    const previous_next_path: ?[]const u8 = if (state.auths.len == 0) null else state.auths[state.rr % state.auths.len].path;
    const previous_last_chosen_path = state.last_chosen_path;
    var next_arena = std.heap.ArenaAllocator.init(state.gpa);
    errdefer next_arena.deinit();
    const aalloc = next_arena.allocator();
    var list: std.ArrayList(AuthEntry) = .empty;

    var dir = try std.Io.Dir.openDirAbsolute(state.io, state.config.auth_dir, .{ .iterate = true });
    defer dir.close(state.io);

    var it = dir.iterate();
    while (try it.next(state.io)) |entry| {
        if (entry.kind != .file) continue;
        if (!std.mem.startsWith(u8, entry.name, "codex-") or !std.mem.endsWith(u8, entry.name, ".json")) continue;
        const path = try std.Io.Dir.path.join(aalloc, &.{ state.config.auth_dir, entry.name });
        const bytes = dir.readFileAlloc(state.io, entry.name, aalloc, .limited(1024 * 1024)) catch continue;
        const parsed = std.json.parseFromSliceLeaky(CodexAuthJson, aalloc, bytes, .{ .ignore_unknown_fields = true, .duplicate_field_behavior = .use_last, .allocate = .alloc_always }) catch continue;
        if (parsed.type) |t| if (!std.mem.eql(u8, t, "codex")) continue;
        if (parsed.access_token.len == 0 or parsed.refresh_token.len == 0) continue;
        const fallback = if (entry.name.len > 11) entry.name[6 .. entry.name.len - 5] else entry.name;
        try list.append(aalloc, .{
            .path = path,
            .label = parsed.email orelse try aalloc.dupe(u8, fallback),
            .data = parsed,
            .cooling_until_ms = oldCooling(state.auths, path),
        });
    }
    std.mem.sort(AuthEntry, list.items, {}, authLess);
    const owned = try list.toOwnedSlice(aalloc);

    // Auth files are sorted on every reload. If a new file sorts before the
    // numeric cursor, preserving only the index can repeat the just-used auth.
    // Realign against stable auth paths before releasing the old arena.
    var next_rr: usize = 0;
    var next_last_chosen_path: ?[]const u8 = null;
    if (owned.len != 0) {
        next_rr = state.rr % owned.len;
        if (previous_last_chosen_path) |last_path| {
            if (authIndexByPath(owned, last_path)) |last_idx| {
                next_rr = (last_idx + 1) % owned.len;
                next_last_chosen_path = owned[last_idx].path;
            } else if (previous_next_path) |next_path| {
                if (authIndexByPath(owned, next_path)) |next_idx| next_rr = next_idx;
            }
        } else if (previous_next_path) |next_path| {
            if (authIndexByPath(owned, next_path)) |next_idx| next_rr = next_idx;
        }
    }

    state.auth_arena.deinit();
    state.auth_arena = next_arena;
    state.auths = owned;
    state.rr = next_rr;
    state.last_chosen_path = next_last_chosen_path;
}

fn nowMs(io: std.Io) i64 {
    return @intCast(@divTrunc(std.Io.Clock.real.now(io).nanoseconds, 1_000_000));
}

fn chooseAuth(state: *State, tried: []const usize) ?usize {
    if (state.auths.len == 0) return null;
    const now = nowMs(state.io);
    var i: usize = 0;
    while (i < state.auths.len) : (i += 1) {
        const idx = state.rr % state.auths.len;
        state.rr += 1;
        const a = &state.auths[idx];
        if (a.data.disabled or a.cooling_until_ms > now) continue;
        var seen = false;
        for (tried) |t| {
            if (t == idx) seen = true;
        }
        if (seen) continue;
        state.last_chosen_path = a.path;
        return idx;
    }
    return null;
}

fn maxAttempts(state: *State) usize {
    const n = if (state.auths.len == 0) 1 else state.auths.len;
    return if (state.config.max_retry_credentials == 0) n else @min(state.config.max_retry_credentials, n);
}

fn unauthorized(state: *State, req: *const std.http.Server.Request) bool {
    const key = state.api_key orelse return false;
    var it = req.iterateHeaders();
    while (it.next()) |h| {
        if (std.ascii.eqlIgnoreCase(h.name, "authorization")) {
            if (!std.mem.startsWith(u8, h.value, "Bearer ")) return true;
            return !std.mem.eql(u8, h.value[7..], key);
        }
    }
    return true;
}

fn targetPath(target: []const u8) []const u8 {
    const start = if (std.mem.indexOf(u8, target, "://")) |scheme| blk: {
        break :blk if (std.mem.indexOfScalarPos(u8, target, scheme + 3, '/')) |slash| slash else return "/";
    } else 0;
    var end = target.len;
    if (std.mem.indexOfScalarPos(u8, target, start, '?')) |q| end = @min(end, q);
    if (std.mem.indexOfScalarPos(u8, target, start, '#')) |h| end = @min(end, h);
    const p = target[start..end];
    return if (p.len == 0) "/" else p;
}

fn targetQueryParam(allocator: std.mem.Allocator, target: []const u8, name: []const u8) !?[]const u8 {
    const q = std.mem.indexOfScalar(u8, target, '?') orelse return null;
    const end = std.mem.indexOfScalarPos(u8, target, q + 1, '#') orelse target.len;
    var it = std.mem.splitScalar(u8, target[q + 1 .. end], '&');
    while (it.next()) |part| {
        const eq = std.mem.indexOfScalar(u8, part, '=') orelse part.len;
        if (std.mem.eql(u8, part[0..eq], name)) return try allocator.dupe(u8, if (eq < part.len) part[eq + 1 ..] else "");
    }
    return null;
}

const UpstreamPath = enum { models, responses, responses_compact };

fn upstreamPath(path: []const u8) ?UpstreamPath {
    if (std.mem.eql(u8, path, "/v1/models") or std.mem.eql(u8, path, "/models")) return .models;
    if (std.mem.eql(u8, path, "/v1/responses") or std.mem.eql(u8, path, "/responses") or std.mem.eql(u8, path, "/codex/responses") or std.mem.eql(u8, path, "/backend-api/codex/responses")) return .responses;
    if (std.mem.eql(u8, path, "/v1/responses/compact") or std.mem.eql(u8, path, "/responses/compact") or std.mem.eql(u8, path, "/codex/responses/compact") or std.mem.eql(u8, path, "/backend-api/codex/responses/compact")) return .responses_compact;
    return null;
}

fn methodFromServer(m: std.http.Method) std.http.Method {
    return m;
}

fn requestBodyAlloc(req: *std.http.Server.Request, allocator: std.mem.Allocator) !?[]u8 {
    if (!req.head.method.requestHasBody()) return null;
    var buf: [8192]u8 = undefined;
    const r = try req.readerExpectContinue(&buf);
    return try r.allocRemaining(allocator, .limited(64 * 1024 * 1024));
}

fn contentTypeOf(req: *const std.http.Server.Request) ?[]const u8 {
    var it = req.iterateHeaders();
    while (it.next()) |h| if (std.ascii.eqlIgnoreCase(h.name, "content-type")) return h.value;
    return null;
}

fn upstreamUrl(allocator: std.mem.Allocator, state: *State, path: UpstreamPath) ![]const u8 {
    return switch (path) {
        .responses => try std.fmt.allocPrint(allocator, "{s}/responses", .{state.config.upstream_base}),
        .responses_compact => try std.fmt.allocPrint(allocator, "{s}/responses/compact", .{state.config.upstream_base}),
        else => unreachable,
    };
}

fn isRetryable(status: u16) bool {
    return status == 401 or status == 403 or status == 408 or status == 409 or status == 425 or status == 429 or status == 500 or status == 502 or status == 503 or status == 504;
}

fn cooldownFor(state: *State, status: u16) i64 {
    if (status == 401 or status == 403 or status == 429) return state.config.cooldown_ms;
    return @min(state.config.cooldown_ms, 5000);
}

fn bearerValue(allocator: std.mem.Allocator, token: []const u8) ![]const u8 {
    return std.fmt.allocPrint(allocator, "Bearer {s}", .{token});
}

fn fetchWithAuth(state: *State, allocator: std.mem.Allocator, method: std.http.Method, content_type: ?[]const u8, path: UpstreamPath, auth: *AuthEntry, body: ?[]const u8) !struct { status: u16, body: []u8 } {
    const url = try upstreamUrl(allocator, state, path);
    const authorization = try bearerValue(allocator, auth.data.access_token);
    var headers_list: std.ArrayList(std.http.Header) = .empty;
    try headers_list.append(allocator, .{ .name = "authorization", .value = authorization });
    if (auth.data.account_id) |id| try headers_list.append(allocator, .{ .name = "ChatGPT-Account-ID", .value = id });
    if (content_type) |ct| try headers_list.append(allocator, .{ .name = "content-type", .value = ct }) else try headers_list.append(allocator, .{ .name = "content-type", .value = "application/json" });
    try headers_list.append(allocator, .{ .name = "accept", .value = "text/event-stream" });

    var aw = std.Io.Writer.Allocating.init(allocator);
    errdefer aw.deinit();
    const result = try state.http_client.fetch(.{
        .location = .{ .url = url },
        .method = methodFromServer(method),
        .payload = body,
        .response_writer = &aw.writer,
        .headers = .{ .authorization = .omit, .content_type = .omit },
        .extra_headers = headers_list.items,
        .redirect_behavior = .unhandled,
    });
    const out = try aw.toOwnedSlice();
    return .{ .status = @intFromEnum(result.status), .body = out };
}

fn hexNibble(n: u8) u8 { return if (n < 10) '0' + n else 'A' + (n - 10); }

fn appendFormEncoded(w: *std.Io.Writer, value: []const u8) !void {
    for (value) |c| {
        if (std.ascii.isAlphanumeric(c) or c == '-' or c == '_' or c == '.' or c == '~') try w.writeByte(c)
        else if (c == ' ') try w.writeByte('+')
        else {
            try w.writeByte('%');
            try w.writeByte(hexNibble(c >> 4));
            try w.writeByte(hexNibble(c & 0xf));
        }
    }
}

fn persistAuth(state: *State, allocator: std.mem.Allocator, auth: *const AuthEntry) !void {
    var w = std.Io.Writer.Allocating.init(allocator);
    defer w.deinit();
    try w.writer.writeAll("{\"type\":\"codex\"");
    if (auth.data.email) |v| { try w.writer.writeAll(",\"email\":"); try writeJsonString(&w.writer, v); }
    if (auth.data.account_id) |v| { try w.writer.writeAll(",\"account_id\":"); try writeJsonString(&w.writer, v); }
    try w.writer.writeAll(",\"access_token\":"); try writeJsonString(&w.writer, auth.data.access_token);
    try w.writer.writeAll(",\"refresh_token\":"); try writeJsonString(&w.writer, auth.data.refresh_token);
    if (auth.data.id_token) |v| { try w.writer.writeAll(",\"id_token\":"); try writeJsonString(&w.writer, v); }
    if (auth.data.expired) |v| { try w.writer.writeAll(",\"expired\":"); try writeJsonString(&w.writer, v); }
    if (auth.data.last_refresh) |v| { try w.writer.writeAll(",\"last_refresh\":"); try writeJsonString(&w.writer, v); }
    try w.writer.print(",\"disabled\":{} }}\n", .{auth.data.disabled});
    var file = try std.Io.Dir.createFileAbsolute(state.io, auth.path, .{ .truncate = true, .permissions = @enumFromInt(0o600) });
    defer file.close(state.io);
    try file.writeStreamingAll(state.io, w.writer.buffered());
}

fn refreshAuth(state: *State, allocator: std.mem.Allocator, auth: *AuthEntry) !void {
    var body_w = std.Io.Writer.Allocating.init(allocator);
    defer body_w.deinit();
    try body_w.writer.writeAll("client_id=");
    try appendFormEncoded(&body_w.writer, CODEX_CLIENT_ID);
    try body_w.writer.writeAll("&grant_type=refresh_token&refresh_token=");
    try appendFormEncoded(&body_w.writer, auth.data.refresh_token);
    try body_w.writer.writeAll("&scope=openid+profile+email");
    const form = body_w.writer.buffered();

    var resp_w = std.Io.Writer.Allocating.init(allocator);
    defer resp_w.deinit();
    const result = try state.http_client.fetch(.{
        .location = .{ .url = CODEX_TOKEN_URL },
        .method = .POST,
        .payload = form,
        .response_writer = &resp_w.writer,
        .headers = .{ .content_type = .{ .override = "application/x-www-form-urlencoded" } },
        .extra_headers = &.{.{ .name = "accept", .value = "application/json" }},
        .redirect_behavior = .unhandled,
    });
    const resp = resp_w.writer.buffered();
    if (@intFromEnum(result.status) < 200 or @intFromEnum(result.status) >= 300) return error.RefreshFailed;
    const token = try std.json.parseFromSliceLeaky(TokenJson, state.auth_arena.allocator(), resp, .{ .ignore_unknown_fields = true, .duplicate_field_behavior = .use_last, .allocate = .alloc_always });
    auth.data.access_token = token.access_token orelse return error.RefreshFailed;
    auth.data.refresh_token = token.refresh_token orelse return error.RefreshFailed;
    auth.data.id_token = token.id_token orelse auth.data.id_token;
    auth.data.expired = if (token.expires_in) |sec| try std.fmt.allocPrint(state.auth_arena.allocator(), "{d}", .{nowMs(state.io) + sec * 1000}) else auth.data.expired;
    auth.data.last_refresh = try std.fmt.allocPrint(state.auth_arena.allocator(), "{d}", .{nowMs(state.io)});
    try persistAuth(state, allocator, auth);
}

fn statusText(status: u16) std.http.Status {
    return @enumFromInt(status);
}

fn jsonHeader() []const std.http.Header {
    return &.{.{ .name = "content-type", .value = "application/json" }};
}

fn respondJson(req: *std.http.Server.Request, body: []const u8, status: u16) !void {
    try req.respond(body, .{ .status = statusText(status), .extra_headers = jsonHeader() });
}

fn writeJsonString(w: *std.Io.Writer, s: []const u8) !void {
    try w.writeByte('"');
    for (s) |c| switch (c) {
        '"' => try w.writeAll("\\\""),
        '\\' => try w.writeAll("\\\\"),
        '\n' => try w.writeAll("\\n"),
        '\r' => try w.writeAll("\\r"),
        '\t' => try w.writeAll("\\t"),
        else => if (c < 0x20) try w.print("\\u{x:0>4}", .{c}) else try w.writeByte(c),
    };
    try w.writeByte('"');
}

fn respondHealth(state: *State, req: *std.http.Server.Request, allocator: std.mem.Allocator) !void {
    var w = std.Io.Writer.Allocating.init(allocator);
    defer w.deinit();
    try w.writer.print("{{\n  \"ok\": true,\n  \"native_implementation\": true,\n  \"pure_zig\": true,\n  \"upstream_base\": ", .{});
    try writeJsonString(&w.writer, state.config.upstream_base);
    try w.writer.print(",\n  \"auths\": {d},\n  \"auth_dir\": ", .{state.enabledCount()});
    try writeJsonString(&w.writer, state.config.auth_dir);
    try w.writer.print(",\n  \"transport_stats\": {{\n    \"responsesHttpRequests\": {d},\n    \"responsesWebSocketUpgrades\": {d},\n    \"responsesWebSocketUpstreamOpens\": {d},\n    \"responsesWebSocketTerminalEvents\": {d}\n  }}\n}}", .{ state.stats.responses_http_requests, state.stats.responses_websocket_upgrades, state.stats.responses_websocket_upstream_opens, state.stats.responses_websocket_terminal_events });
    try respondJson(req, w.writer.buffered(), 200);
}

fn respondModels(state: *State, req: *std.http.Server.Request, allocator: std.mem.Allocator) !void {
    var w = std.Io.Writer.Allocating.init(allocator);
    defer w.deinit();
    try w.writer.writeAll("{\n  \"object\": \"list\",\n  \"data\": [\n");
    for (state.config.models, 0..) |m, i| {
        try w.writer.writeAll("    { \"id\": ");
        try writeJsonString(&w.writer, m);
        try w.writer.writeAll(", \"object\": \"model\", \"created\": 1770307200, \"owned_by\": \"openai\" }");
        if (i + 1 < state.config.models.len) try w.writer.writeAll(",");
        try w.writer.writeAll("\n");
    }
    try w.writer.writeAll("  ]\n}");
    try respondJson(req, w.writer.buffered(), 200);
}

fn respondStatus(state: *State, req: *std.http.Server.Request, allocator: std.mem.Allocator) !void {
    var w = std.Io.Writer.Allocating.init(allocator);
    defer w.deinit();
    try w.writer.print("{{\n  \"ok\": true,\n  \"native_implementation\": true,\n  \"pure_zig\": true,\n  \"upstream_base\": ", .{});
    try writeJsonString(&w.writer, state.config.upstream_base);
    try w.writer.print(",\n  \"rr_index\": {d},\n  \"transport_stats\": {{\n    \"responsesHttpRequests\": {d},\n    \"responsesWebSocketUpgrades\": {d},\n    \"responsesWebSocketUpstreamOpens\": {d},\n    \"responsesWebSocketTerminalEvents\": {d}\n  }},\n  \"auths\": [\n", .{ if (state.auths.len == 0) 0 else state.rr % state.auths.len, state.stats.responses_http_requests, state.stats.responses_websocket_upgrades, state.stats.responses_websocket_upstream_opens, state.stats.responses_websocket_terminal_events });
    for (state.auths, 0..) |a, i| {
        try w.writer.writeAll("    { \"label\": ");
        try writeJsonString(&w.writer, a.label);
        try w.writer.print(", \"disabled\": {}, \"cooling_ms\": {d}, \"file\": ", .{ a.data.disabled, @max(0, a.cooling_until_ms - nowMs(state.io)) });
        try writeJsonString(&w.writer, a.path);
        try w.writer.writeAll(" }");
        if (i + 1 < state.auths.len) try w.writer.writeAll(",");
        try w.writer.writeAll("\n");
    }
    try w.writer.writeAll("  ]\n}");
    try respondJson(req, w.writer.buffered(), 200);
}

fn respondDebugRotation(state: *State, req: *std.http.Server.Request, target: []const u8, allocator: std.mem.Allocator) !void {
    const raw_count = try targetQueryParam(allocator, target, "count") orelse "";
    const count = if (raw_count.len == 0) @max(@as(usize, 1), state.auths.len) else @min(@as(usize, 100), std.fmt.parseInt(usize, raw_count, 10) catch 1);
    const tried_buf = std.mem.zeroes([256]usize);
    var w = std.Io.Writer.Allocating.init(allocator);
    defer w.deinit();
    try w.writer.print("{{\n  \"ok\": true,\n  \"count\": {d},\n  \"picked\": [\n", .{count});
    for (0..count) |i| {
        const picked = chooseAuth(state, tried_buf[0..0]);
        try w.writer.writeAll("    ");
        if (picked) |idx| {
            try w.writer.writeAll("{ \"label\": ");
            try writeJsonString(&w.writer, state.auths[idx].label);
            try w.writer.writeAll(" }");
        } else try w.writer.writeAll("null");
        if (i + 1 < count) try w.writer.writeAll(",");
        try w.writer.writeAll("\n");
    }
    try w.writer.print("  ],\n  \"next_rr_index\": {d}\n}}", .{if (state.auths.len == 0) 0 else state.rr % state.auths.len});
    try respondJson(req, w.writer.buffered(), 200);
}

fn proxyHttp(state: *State, req: *std.http.Server.Request, path: UpstreamPath, allocator: std.mem.Allocator) !void {
    if (path == .responses or path == .responses_compact) state.stats.responses_http_requests += 1;
    if (state.auths.len == 0) return respondJson(req, "{\"error\":{\"message\":\"no codex auth files found\"}}", 503);
    const method = req.head.method;
    const content_type = contentTypeOf(req);
    const body = try requestBodyAlloc(req, allocator);
    var tried: [1024]usize = undefined;
    var tried_len: usize = 0;
    var last_status: u16 = 503;

    var attempt: usize = 0;
    while (attempt < maxAttempts(state)) : (attempt += 1) {
        const idx = chooseAuth(state, tried[0..tried_len]) orelse break;
        tried[tried_len] = idx;
        tried_len += 1;
        const auth = &state.auths[idx];
        log(state, "{s} upstream as {s}", .{ @tagName(method), auth.label });
        var upstream = fetchWithAuth(state, allocator, method, content_type, path, auth, body) catch |err| {
            last_status = 502;
            auth.cooling_until_ms = nowMs(state.io) + cooldownFor(state, 502);
            log(state, "cooling {s} after fetch error {s}", .{ auth.label, @errorName(err) });
            continue;
        };
        if (upstream.status == 401) {
            refreshAuth(state, allocator, auth) catch {};
            upstream = fetchWithAuth(state, allocator, method, content_type, path, auth, body) catch upstream;
        }
        if (isRetryable(upstream.status)) {
            last_status = upstream.status;
            auth.cooling_until_ms = nowMs(state.io) + cooldownFor(state, upstream.status);
            log(state, "cooling {s} after status {d}", .{ auth.label, upstream.status });
            continue;
        }
        var headers: [5]std.http.Header = .{
            .{ .name = "content-type", .value = "application/json" },
            .{ .name = "x-cd-proxy-auth-label", .value = auth.label },
            .{ .name = "x-cd-proxy-attempt", .value = "0" },
            .{ .name = "x-cd-proxy-native", .value = "pure-zig" },
            .{ .name = "x-cd-proxy-unused", .value = "" },
        };
        const extra = if (state.config.expose_rotation_headers) headers[0..4] else headers[0..1];
        return req.respond(upstream.body, .{ .status = statusText(upstream.status), .extra_headers = extra });
    }
    try respondJson(req, "{\"error\":{\"message\":\"all codex credentials failed or are cooling down\"}}", last_status);
}

fn isWsUpgrade(req: *const std.http.Server.Request) bool {
    var it = req.iterateHeaders();
    while (it.next()) |h| {
        if (std.ascii.eqlIgnoreCase(h.name, "upgrade") and std.ascii.eqlIgnoreCase(h.value, "websocket")) return true;
    }
    return false;
}

fn respondWebSocketUnsupported(req: *std.http.Server.Request) !void {
    return respondJson(req, "{\"error\":{\"message\":\"pure Zig WebSocket proxy was removed; use the default Bun runtime\"}}", 501);
}

fn handleRequest(state: *State, req: *std.http.Server.Request, allocator: std.mem.Allocator) !void {
    const target_copy = try allocator.dupe(u8, req.head.target);
    const path = targetPath(target_copy);
    log(state, "request {s} {s}", .{ @tagName(req.head.method), path });
    if (isWsUpgrade(req)) {
        log(state, "WS upgrade request {s}", .{path});
        if (unauthorized(state, req)) return respondJson(req, "{\"error\":{\"message\":\"unauthorized\"}}", 401);
        const up = upstreamPath(path) orelse return respondJson(req, "{\"error\":{\"message\":\"websocket endpoint not found\"}}", 404);
        if (up != .responses) return respondJson(req, "{\"error\":{\"message\":\"websocket endpoint not found\"}}", 404);
        return respondWebSocketUnsupported(req);
    }
    if (std.mem.eql(u8, path, "/health") or std.mem.eql(u8, path, "/v1/health")) return respondHealth(state, req, allocator);
    if (std.mem.eql(u8, path, "/reload") and req.head.method == .POST) {
        if (unauthorized(state, req)) return respondJson(req, "{\"error\":{\"message\":\"unauthorized\"}}", 401);
        try loadAuths(state);
        return respondJson(req, "{\"ok\":true}", 200);
    }
    if (unauthorized(state, req)) return respondJson(req, "{\"error\":{\"message\":\"unauthorized\"}}", 401);
    if (std.mem.eql(u8, path, "/status") or std.mem.eql(u8, path, "/v1/status")) return respondStatus(state, req, allocator);
    if (std.mem.eql(u8, path, "/debug/rotation") or std.mem.eql(u8, path, "/v1/debug/rotation")) return respondDebugRotation(state, req, target_copy, allocator);
    const up = upstreamPath(path) orelse return respondJson(req, "{\"error\":{\"message\":\"not found\"}}", 404);
    if (up == .models) return respondModels(state, req, allocator);
    return proxyHttp(state, req, up, allocator);
}

fn handleConnectionThread(state: *State, stream: std.Io.net.Stream) void {
    handleConnection(state, stream) catch |err| std.debug.print("connection failed: {s}\n", .{@errorName(err)});
}

fn serve(state: *State) !void {
    var addr = try std.Io.net.IpAddress.parse(state.config.host, state.config.port);
    var listener = try addr.listen(state.io, .{ .reuse_address = true });
    defer listener.deinit(state.io);
    std.debug.print("cd-proxy-zig listening on http://{s}:{d} using {d} codex auth(s); upstream={s}\n", .{ state.config.host, state.config.port, state.auths.len, state.config.upstream_base });
    while (true) {
        const stream = listener.accept(state.io) catch |err| {
            std.debug.print("accept failed: {s}\n", .{@errorName(err)});
            continue;
        };
        const t = std.Thread.spawn(.{}, handleConnectionThread, .{ state, stream }) catch |err| {
            std.debug.print("spawn failed: {s}\n", .{@errorName(err)});
            stream.close(state.io);
            continue;
        };
        t.detach();
    }
}

fn handleConnection(state: *State, stream: std.Io.net.Stream) !void {
    defer stream.close(state.io);
    var read_buf: [64 * 1024]u8 = undefined;
    var write_buf: [64 * 1024]u8 = undefined;
    var sr = stream.reader(state.io, &read_buf);
    var sw = stream.writer(state.io, &write_buf);
    var server = std.http.Server.init(&sr.interface, &sw.interface);
    while (true) {
        var req = server.receiveHead() catch |err| switch (err) {
            error.HttpRequestTruncated, error.HttpConnectionClosing => return,
            else => return err,
        };
        var arena = std.heap.ArenaAllocator.init(state.gpa);
        defer arena.deinit();
        handleRequest(state, &req, arena.allocator()) catch |err| {
            std.debug.print("request failed: {s}\n", .{@errorName(err)});
            req.respond("{\"error\":{\"message\":\"internal server error\"}}", .{ .status = .internal_server_error, .extra_headers = jsonHeader(), .keep_alive = false }) catch {};
            return;
        };
        if (!req.head.keep_alive) return;
    }
}

fn buildConfig(init: std.process.Init) !Config {
    const gpa = init.gpa;
    const env = init.environ_map;
    const home = env.get("HOME") orelse ".";
    const auth_dir = try expandHome(gpa, env.get("CD_PROXY_AUTH_DIR") orelse "~/.local/share/cd-proxy/auths", home);
    const api_key_file = try expandHome(gpa, env.get("CD_PROXY_API_KEY_FILE") orelse "~/.config/cd-proxy/api-key", home);
    const upstream = env.get("CD_PROXY_UPSTREAM_BASE") orelse DEFAULT_CHATGPT_CODEX_BASE;
    const models_raw = env.get("CD_PROXY_MODELS") orelse "gpt-5.3-codex,gpt-5.3-codex-spark,codex-auto-review,gpt-5.5,gpt-5.2";
    return .{
        .home = home,
        .host = env.get("CD_PROXY_HOST") orelse "127.0.0.1",
        .port = envInt(u16, env, "CD_PROXY_PORT", 8318),
        .auth_dir = auth_dir,
        .api_key_file = api_key_file,
        .api_key_env = env.get("CD_PROXY_API_KEY"),
        .upstream_base = upstream,
        .cooldown_ms = envInt(i64, env, "CD_PROXY_COOLDOWN_MS", 30000),
        .max_retry_credentials = envInt(usize, env, "CD_PROXY_MAX_RETRY_CREDENTIALS", 0),
        .expose_rotation_headers = envBool(env, "CD_PROXY_EXPOSE_ROTATION_HEADERS"),
        .debug = envBool(env, "CD_PROXY_DEBUG"),
        .models = try splitCsv(gpa, models_raw),
    };
}

fn printCheck(state: *State) !void {
    std.debug.print("{{\n  \"ok\": {},\n  \"native_implementation\": true,\n  \"pure_zig\": true,\n  \"upstream_base\": \"{s}\",\n  \"auths\": {d},\n  \"api_key\": {}\n}}\n", .{ state.auths.len > 0, state.config.upstream_base, state.auths.len, state.api_key != null });
}

pub fn main(init: std.process.Init) !void {
    const config = try buildConfig(init);
    var state = State{
        .gpa = init.gpa,
        .io = init.io,
        .config = config,
        .auth_arena = std.heap.ArenaAllocator.init(init.gpa),
        .http_client = .{ .allocator = init.gpa, .io = init.io },
    };
    defer state.http_client.deinit();
    defer state.auth_arena.deinit();

    try loadApiKey(&state);
    loadAuths(&state) catch |err| std.debug.print("warning: failed to load auths from {s}: {s}\n", .{ state.config.auth_dir, @errorName(err) });

    var args_it = try std.process.Args.Iterator.initAllocator(init.minimal.args, init.gpa);
    defer args_it.deinit();
    _ = args_it.skip();
    while (args_it.next()) |arg| {
        if (std.mem.eql(u8, arg, "--check")) {
            try printCheck(&state);
            std.process.exit(if (state.auths.len > 0) 0 else 1);
        }
        if (std.mem.eql(u8, arg, "--serve")) break;
    }
    try serve(&state);
}
