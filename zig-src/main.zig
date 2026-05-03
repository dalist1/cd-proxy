const std = @import("std");

const Auth = struct {
    file: []const u8,
    label: []const u8,
    account_id: ?[]const u8,
    disabled: bool,
};

fn expandHome(allocator: std.mem.Allocator, input: []const u8, home: []const u8) ![]const u8 {
    if (std.mem.eql(u8, input, "~")) {
        return try allocator.dupe(u8, home);
    }
    if (std.mem.startsWith(u8, input, "~/")) {
        return try std.fmt.allocPrint(allocator, "{s}{s}", .{ home, input[1..] });
    }
    return try allocator.dupe(u8, input);
}

fn jsonString(obj: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const v = obj.get(key) orelse return null;
    return switch (v) {
        .string => |s| s,
        else => null,
    };
}

fn jsonBool(obj: std.json.ObjectMap, key: []const u8) bool {
    const v = obj.get(key) orelse return false;
    return switch (v) {
        .bool => |b| b,
        else => false,
    };
}

fn redact(s: []const u8) []const u8 {
    if (s.len <= 10) return "REDACTED";
    return s[0..5]; // intentionally only prefix in Zig checker output
}

fn loadAuths(allocator: std.mem.Allocator, io: std.Io, auth_dir: []const u8) !std.ArrayList(Auth) {
    var list: std.ArrayList(Auth) = .empty;
    var dir = try std.Io.Dir.openDirAbsolute(io, auth_dir, .{ .iterate = true });
    defer dir.close(io);

    var it = dir.iterate();
    while (try it.next(io)) |entry| {
        if (entry.kind != .file) continue;
        if (!std.mem.startsWith(u8, entry.name, "codex-") or !std.mem.endsWith(u8, entry.name, ".json")) continue;

        const path = try std.Io.Dir.path.join(allocator, &.{ auth_dir, entry.name });
        const bytes = dir.readFileAlloc(io, entry.name, allocator, .limited(1024 * 1024)) catch {
            allocator.free(path);
            continue;
        };
        defer allocator.free(bytes);

        var parsed = std.json.parseFromSlice(std.json.Value, allocator, bytes, .{}) catch {
            allocator.free(path);
            continue;
        };
        defer parsed.deinit();

        const obj = switch (parsed.value) { .object => |o| o, else => { allocator.free(path); continue; } };
        if (jsonString(obj, "access_token") == null or jsonString(obj, "refresh_token") == null) {
            allocator.free(path);
            continue;
        }
        const email = jsonString(obj, "email") orelse entry.name;
        try list.append(allocator, .{
            .file = path,
            .label = try allocator.dupe(u8, email),
            .account_id = if (jsonString(obj, "account_id")) |a| try allocator.dupe(u8, a) else null,
            .disabled = jsonBool(obj, "disabled"),
        });
    }
    return list;
}

pub fn main(init: std.process.Init) !void {
    const allocator = init.gpa;

    const home = init.environ_map.get("HOME") orelse ".";
    const env_dir = init.environ_map.get("CD_PROXY_AUTH_DIR") orelse "~/.local/share/cd-proxy/auths";
    const auth_dir = try expandHome(allocator, env_dir, home);
    defer allocator.free(auth_dir);

    var auths = loadAuths(allocator, init.io, auth_dir) catch |err| {
        std.debug.print("failed to read auth dir {s}: {s}\n", .{ auth_dir, @errorName(err) });
        std.process.exit(1);
    };
    defer {
        for (auths.items) |a| {
            allocator.free(a.file);
            allocator.free(a.label);
            if (a.account_id) |id| allocator.free(id);
        }
        auths.deinit(allocator);
    }

    std.debug.print("cd-proxy-zig: found {d} codex auth(s) in {s}\n", .{ auths.items.len, auth_dir });
    for (auths.items, 0..) |a, i| {
        std.debug.print("{d}: {s} disabled={} account_prefix={s}\n", .{ i, a.label, a.disabled, if (a.account_id) |id| redact(id) else "none" });
    }
    if (auths.items.len == 0) std.process.exit(1);
}
