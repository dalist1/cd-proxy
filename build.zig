const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const exe = b.addExecutable(.{
        .name = "cd-proxy-zig",
        .root_module = b.createModule(.{
            .root_source_file = b.path("zig-src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(exe);

    const core_lib = b.addLibrary(.{
        .name = "cd_proxy_core",
        .linkage = .dynamic,
        .root_module = b.createModule(.{
            .root_source_file = b.path("zig-src/core.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(core_lib);

    const core_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("zig-src/core.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    const run_core_tests = b.addRunArtifact(core_tests);
    const test_step = b.step("test", "Run Zig core tests");
    test_step.dependOn(&run_core_tests.step);

    const run = b.addRunArtifact(exe);
    if (b.args) |args| run.addArgs(args);
    const run_step = b.step("run", "Run the Zig auth checker");
    run_step.dependOn(&run.step);
}
