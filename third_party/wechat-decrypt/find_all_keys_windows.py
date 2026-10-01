"""
从微信进程内存中提取所有数据库的缓存raw key

WCDB为每个DB缓存: x'<64hex_enc_key><32hex_salt>'
salt嵌在hex字符串中，可以直接匹配DB文件的salt
"""
import ctypes
import ctypes.wintypes as wt
import os, sys, time, re, json

import functools
print = functools.partial(print, flush=True)

from key_scan_common import (
    collect_db_files, scan_memory_for_keys, cross_verify_keys, save_results,
)

from wcdb_cipher_scan import (
    CIPHER_NAME, HEX_LITERAL, memory_chunks, find_addresses, scan_cipher_references,
)

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
MEM_COMMIT = 0x1000
READABLE = {0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80}


class MBI(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_uint64), ("AllocationBase", ctypes.c_uint64),
        ("AllocationProtect", wt.DWORD), ("_pad1", wt.DWORD),
        ("RegionSize", ctypes.c_uint64), ("State", wt.DWORD),
        ("Protect", wt.DWORD), ("Type", wt.DWORD), ("_pad2", wt.DWORD),
    ]


# Explicit x64 signatures prevent handles and sizes being truncated by ctypes.
kernel32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
kernel32.OpenProcess.restype = wt.HANDLE
kernel32.VirtualQueryEx.argtypes = [wt.HANDLE, ctypes.c_void_p, ctypes.POINTER(MBI), ctypes.c_size_t]
kernel32.VirtualQueryEx.restype = ctypes.c_size_t
kernel32.ReadProcessMemory.argtypes = [wt.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
kernel32.ReadProcessMemory.restype = wt.BOOL
kernel32.CloseHandle.argtypes = [wt.HANDLE]
kernel32.CloseHandle.restype = wt.BOOL


def get_pids():
    """Get processes and full executable versions without localized tasklist parsing."""
    import subprocess
    command = (
        "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); "
        "@(Get-Process -Name Weixin -ErrorAction SilentlyContinue | "
        "Select-Object Id,WorkingSet64,@{Name='Version';Expression={$_.MainModule.FileVersionInfo.FileVersion}}) "
        "| ConvertTo-Json -Compress"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", command],
        capture_output=True, text=True, encoding="utf-8", check=True,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    processes = json.loads(result.stdout.strip() or "[]")
    if isinstance(processes, dict):
        processes = [processes]
    pids = sorted(((int(p["Id"]), int(p["WorkingSet64"]) // 1024) for p in processes),
                  key=lambda item: item[1], reverse=True)
    if not pids:
        raise RuntimeError("Weixin.exe 未运行")
    versions = {int(p["Id"]): p.get("Version") for p in processes}
    for pid, mem in pids:
        print(f"[+] Weixin.exe PID={pid} ({mem // 1024}MB), 版本={versions[pid] or '无法读取'}")
    return pids


def read_mem(h, addr, sz):
    buf = ctypes.create_string_buffer(sz)
    n = ctypes.c_size_t(0)
    ok = kernel32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, sz, ctypes.byref(n))
    if n.value:
        return buf.raw[:n.value]
    return None


def enum_regions(h):
    regs = []
    addr = 0
    mbi = MBI()
    while addr < 0x7FFFFFFFFFFF:
        if kernel32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)) == 0:
            break
        if mbi.State == MEM_COMMIT and (mbi.Protect & 0xFF) in READABLE and not (mbi.Protect & 0x100) and mbi.RegionSize > 0:
            regs.append((mbi.BaseAddress, mbi.RegionSize))
        nxt = mbi.BaseAddress + mbi.RegionSize
        if nxt <= addr:
            break
        addr = nxt
    return regs


def main():
    if ctypes.sizeof(ctypes.c_void_p) != 8:
        raise RuntimeError("请使用 64 位 Python；32 位 Python 无法完整扫描 64 位微信内存")
    from config import load_config
    _cfg = load_config()
    db_dir = _cfg["db_dir"]
    out_file = _cfg["keys_file"]

    print("=" * 60)
    print("  提取所有微信数据库密钥")
    print("=" * 60)

    # 1. 收集所有DB文件及其salt
    db_files, salt_to_dbs = collect_db_files(db_dir)

    print(f"\n找到 {len(db_files)} 个数据库, {len(salt_to_dbs)} 个不同的salt")
    for salt_hex, dbs in sorted(salt_to_dbs.items(), key=lambda x: len(x[1]), reverse=True):
        print(f"  salt {salt_hex}: {', '.join(dbs)}")

    # 2. 打开所有微信进程
    pids = get_pids()

    hex_re = HEX_LITERAL
    key_map = {}
    remaining_salts = set(salt_to_dbs.keys())
    all_hex_matches = 0
    t0 = time.time()

    for pid, mem_kb in pids:
        h = kernel32.OpenProcess(0x0010 | 0x0400, False, pid)
        if not h:
            print(f"[WARN] 无法打开进程 PID={pid}，Windows 错误码={ctypes.get_last_error()}，跳过")
            continue

        try:
            regions = enum_regions(h)
            total_bytes = sum(s for _, s in regions)
            total_mb = total_bytes / 1024 / 1024
            print(f"\n[*] 扫描 PID={pid} ({total_mb:.0f}MB, {len(regions)} 区域)")

            reads = {"bytes": 0, "failed": 0, "error": 0}

            def read(address, length):
                data = read_mem(h, address, length)
                if data:
                    reads["bytes"] += len(data)
                else:
                    reads["failed"] += 1
                    reads["error"] = ctypes.get_last_error()
                return data

            name_addresses = set()
            for base, data in memory_chunks(read, regions):
                name_addresses.update(find_addresses(data, base, CIPHER_NAME))
                all_hex_matches += scan_memory_for_keys(
                    data, hex_re, db_files, salt_to_dbs,
                    key_map, remaining_salts, base, pid, print,
                )
                if not remaining_salts:
                    break
            print(f"  [读取] 实际读取 {reads['bytes'] / 1024 / 1024:.1f}MB，失败 {reads['failed']} 次")
            print(f"  [Config.Cipher] 找到 {len(name_addresses)} 处名称，开始解析配置对象")
            stats = scan_cipher_references(
                read, regions, name_addresses, db_files, key_map, remaining_salts, print,
            )
            print(f"  [Config.Cipher] 引用 {stats['references']}，解码对象 {stats['decoded']}，已验证密钥 {stats['found']}")
            if reads["bytes"] == 0:
                print(f"  [WARN] 无内存读取成功，Windows 错误码={reads['error']}；检查权限和安全软件")
            elif name_addresses and not stats["decoded"] and remaining_salts:
                print("  [WARN] 配置对象未能解析，可能是具体微信版本的结构变化")
            elif stats["decoded"] and not stats["found"] and remaining_salts:
                print("  [WARN] 对象已解码但密钥未通过验证，请核对 db_dir 是否属于当前登录账号")
        finally:
            kernel32.CloseHandle(h)

        if not remaining_salts:
            print(f"\n[+] 所有密钥已找到，跳过剩余进程")
            break

    elapsed = time.time() - t0
    print(f"\n扫描完成: {elapsed:.1f}s, {len(pids)} 个进程, {all_hex_matches} hex模式")

    cross_verify_keys(db_files, salt_to_dbs, key_map, print)
    save_results(db_files, salt_to_dbs, key_map, db_dir, out_file, print)


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as e:
        print(f"\n[ERROR] {e}")
        sys.exit(1)
