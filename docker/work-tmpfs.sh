#!/bin/sh
# Size the WORK_DIR tmpfs from the container's detected memory limit, then hand off to
# the real command (supervisord). Runs under tini as an entrypoint shim.
#
# The tmpfs holding the RAM-backed working set (unpacked archives + raster caches) has a
# hard size that the Docker daemon fixes at container-create time — it can't know the
# cgroup limit, so a static size wastes RAM on a big box and is too small on a bigger one.
# Here, at runtime, we read the actual limit and remount WORK_DIR to a percentage of it,
# so the tmpfs scales with whatever memory the container was given.
#
# Remounting a filesystem needs CAP_SYS_ADMIN (docker-compose grants it via cap_add). If
# it is missing — or WORK_DIR is not a tmpfs — this is FAIL-OPEN: we log a warning and
# leave WORK_DIR at whatever size it already has (the compose fallback, or plain disk), so
# the app still starts. The app's admission control (which reads the same cgroup limit)
# remains the real memory guard regardless.

WORK_DIR="${SDS_WORK_DIR:-/work}"
PCT="${SDS_WORK_TMPFS_PCT:-85}"

# Detected memory limit in bytes: cgroup v2 memory.max, then v1 limit_in_bytes; when
# unbounded ("max" / a near-INT64 sentinel) fall back to host physical RAM. Mirrors
# backend/app/config.py::_cgroup_mem_limit_mb so the tmpfs and the app's admission math
# size against the same number.
read_limit_bytes() {
    if [ -r /sys/fs/cgroup/memory.max ]; then
        v=$(cat /sys/fs/cgroup/memory.max 2>/dev/null)
        if [ -n "$v" ] && [ "$v" != "max" ]; then echo "$v"; return; fi
    fi
    if [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
        v=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null)
        # v1 reports ~0x7ffffffffffff000 (near 1<<62) when unlimited.
        if [ -n "$v" ] && [ "$v" -lt 4611686018427387904 ] 2>/dev/null; then echo "$v"; return; fi
    fi
    kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)
    if [ -n "$kb" ]; then echo $(( kb * 1024 )); fi
}

limit_bytes=$(read_limit_bytes)
if [ -n "$limit_bytes" ] && [ "$limit_bytes" -gt 0 ] 2>/dev/null; then
    size_bytes=$(( limit_bytes * PCT / 100 ))
    is_tmpfs=$(awk -v d="$WORK_DIR" '$2==d && $3=="tmpfs"{print 1}' /proc/mounts 2>/dev/null)
    if [ -n "$is_tmpfs" ]; then
        if mount -o "remount,size=${size_bytes},mode=1777" "$WORK_DIR" 2>/dev/null; then
            echo "work-tmpfs: ${WORK_DIR} sized to ${size_bytes}B (${PCT}% of detected ${limit_bytes}B)"
        else
            echo "work-tmpfs: WARN remount of ${WORK_DIR} failed (need CAP_SYS_ADMIN); keeping current size" >&2
        fi
    elif mount -t tmpfs -o "size=${size_bytes},mode=1777" tmpfs "$WORK_DIR" 2>/dev/null; then
        echo "work-tmpfs: mounted tmpfs at ${WORK_DIR}, ${size_bytes}B (${PCT}% of detected ${limit_bytes}B)"
    else
        echo "work-tmpfs: WARN ${WORK_DIR} is not a tmpfs and mount failed (need CAP_SYS_ADMIN); using disk" >&2
    fi
else
    echo "work-tmpfs: WARN could not detect a memory limit; leaving ${WORK_DIR} as-is" >&2
fi

exec "$@"
