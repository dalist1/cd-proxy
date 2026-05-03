const std = @import("std");

/// Pick the next available credential index using a round-robin start point.
///
/// `unavailable_mask` uses bit i == 1 to mean index i must be skipped
/// (disabled, cooling down, or already attempted for this external request).
/// This fast path intentionally supports up to 32 credentials; callers should
/// fall back to their native implementation above that.
export fn cdproxy_pick_next_u32(len: u32, start: u32, unavailable_mask: u32) i32 {
    if (len == 0 or len > 32) return -1;
    const s = start % len;
    var i: u32 = 0;
    while (i < len) : (i += 1) {
        const idx = (s + i) % len;
        const bit: u32 = (@as(u32, 1) << @intCast(idx));
        if ((unavailable_mask & bit) == 0) return @intCast(idx);
    }
    return -1;
}

/// Build a mask bit. Exported mostly for simple FFI sanity checks.
export fn cdproxy_mask_bit_u32(idx: u32) u32 {
    if (idx >= 32) return 0;
    return @as(u32, 1) << @intCast(idx);
}

test "pick_next basic wrap" {
    try std.testing.expectEqual(@as(i32, 0), cdproxy_pick_next_u32(3, 0, 0));
    try std.testing.expectEqual(@as(i32, 1), cdproxy_pick_next_u32(3, 1, 0));
    try std.testing.expectEqual(@as(i32, 2), cdproxy_pick_next_u32(3, 2, 0));
    try std.testing.expectEqual(@as(i32, 0), cdproxy_pick_next_u32(3, 3, 0));
}

test "pick_next skips unavailable" {
    try std.testing.expectEqual(@as(i32, 2), cdproxy_pick_next_u32(3, 1, 0b010));
    try std.testing.expectEqual(@as(i32, 0), cdproxy_pick_next_u32(3, 1, 0b110));
    try std.testing.expectEqual(@as(i32, -1), cdproxy_pick_next_u32(3, 1, 0b111));
}

test "pick_next validates len" {
    try std.testing.expectEqual(@as(i32, -1), cdproxy_pick_next_u32(0, 0, 0));
    try std.testing.expectEqual(@as(i32, -1), cdproxy_pick_next_u32(33, 0, 0));
}
