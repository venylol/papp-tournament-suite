"""Size the pseudo scan against physical cores and half of installed RAM."""
from __future__ import annotations

import ctypes
import os
import struct

MIB = 1024 * 1024
# Observed peaks: parent 844 MiB, matching worker 478 MiB on the v11 pool.
MAIN_MEMORY_BYTES = 1024 * MIB
WORKER_MEMORY_BYTES = 512 * MIB


def device_resources() -> tuple[int, int]:
    logical = os.cpu_count() or 1
    if os.name != "nt":
        return max(1, logical // 2), os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)

    class MemoryStatus(ctypes.Structure):
        _fields_ = [("length", ctypes.c_uint32), ("load", ctypes.c_uint32)] + [
            (name, ctypes.c_uint64) for name in (
                "totalPhysical", "availablePhysical", "totalPageFile", "availablePageFile",
                "totalVirtual", "availableVirtual", "availableExtendedVirtual",
            )
        ]

    status = MemoryStatus()
    status.length = ctypes.sizeof(status)
    if not kernel.GlobalMemoryStatusEx(ctypes.byref(status)):
        raise ctypes.WinError(ctypes.get_last_error())
    # RelationProcessorCore returns one variable-size record per physical core,
    # including cores across processor groups on large Windows machines.
    size = ctypes.c_uint32()
    kernel.GetLogicalProcessorInformationEx(0, None, ctypes.byref(size))
    if not size.value:
        return max(1, logical // 2), status.totalPhysical
    buffer = ctypes.create_string_buffer(size.value)
    if not kernel.GetLogicalProcessorInformationEx(0, buffer, ctypes.byref(size)):
        raise ctypes.WinError(ctypes.get_last_error())
    offset, physical = 0, 0
    while offset < size.value:
        relation, record_size = struct.unpack_from("<II", buffer.raw, offset)
        if record_size < 8 or offset + record_size > size.value:
            raise ValueError("invalid Windows processor topology record")
        physical += relation == 0
        offset += record_size
    return physical or max(1, logical // 2), status.totalPhysical


def worker_limit(physical_cores: int, total_memory_bytes: int) -> int:
    """The stage budget is exactly 50% of installed RAM, not currently free RAM."""
    memory_workers = (total_memory_bytes // 2 - MAIN_MEMORY_BYTES) // WORKER_MEMORY_BYTES
    limit = min(physical_cores, memory_workers)
    if limit < 1:
        raise ValueError("50% of physical RAM cannot hold the scan parent and one worker")
    return limit


def resolve_workers(requested: int | None) -> int:
    physical, total_memory = device_resources()
    limit = worker_limit(physical, total_memory)
    return limit if requested is None else min(requested, limit)
