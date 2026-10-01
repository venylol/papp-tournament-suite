"""Read-only WCDB Config.Cipher scanner for Windows WeChat 4.1.x.

Layout and XOR material adapted from fanyuantaier/wechatauto-replica,
wechatauto/db.py (Apache-2.0). Modified to retain PAPP's per-salt key format.
https://github.com/fanyuantaier/wechatauto-replica/blob/main/wechatauto/db.py
"""
import re
import struct

from key_scan_common import verify_enc_key

CIPHER_NAME = b"com.Tencent.WCDB.Config.Cipher"
XOR_MASK = bytes.fromhex(
    "d2c7442458020000004889442450488b"
    "450048844c2448488944254048584c24"
)
HEX_LITERAL = re.compile(rb"[xX]'([0-9a-fA-F]{64,192})'")
CHUNK_SIZE = 4 * 1024 * 1024
OVERLAP = 256


def memory_chunks(read, regions, chunk_size=CHUNK_SIZE):
    """Bound allocations and retain matches crossing adjacent readable chunks."""
    tail = b""
    previous_end = None
    for base, size in regions:
        offset = 0
        while offset < size:
            address = base + offset
            length = min(chunk_size, size - offset)
            data = read(address, length)
            if data:
                if previous_end != address:
                    tail = b""
                yield address - len(tail), tail + data
                tail = (tail + data)[-OVERLAP:]
                previous_end = address + len(data)
            else:
                tail = b""
                previous_end = None
            offset += length


def find_addresses(data, base, needle):
    offset = data.find(needle)
    while offset >= 0:
        yield base + offset
        offset = data.find(needle, offset + 1)


def decode_cipher_node(read, reference, name_addresses):
    """Resolve the Config.Cipher name/string descriptor and decode its blob."""
    node = read(reference - 0x10, 0x50)
    if not node or len(node) != 0x50:
        return None
    if struct.unpack_from("<Q", node, 0x10)[0] not in name_addresses:
        return None
    if struct.unpack_from("<Q", node, 0x18)[0] != len(CIPHER_NAME):
        return None
    pointer = struct.unpack_from("<Q", node, 0x28)[0]
    if not 0x10000 <= pointer < 0x800000000000:
        return None
    obj = read(pointer + 0x88, 0x28)
    if not obj or len(obj) != 0x28:
        return None
    data_pointer, data_length = struct.unpack_from("<QQ", obj, 0x08)
    if not (0x10000 <= data_pointer < 0x800000000000 and 0 < data_length <= 1024):
        return None
    blob = read(data_pointer, data_length)
    if not blob or len(blob) != data_length:
        return None
    return bytes(value ^ XOR_MASK[i % len(XOR_MASK)] for i, value in enumerate(blob))


def verify_decoded_keys(decoded, db_files, key_map, remaining_salts, tested):
    """Only accept raw keys verified against the selected account's page 1.

    Explicit-salt/plaintext-header variants must not be saved as a standard key:
    PAPP's decryptor currently expects the salt in the encrypted file header.
    """
    found = 0
    for match in HEX_LITERAL.finditer(decoded):
        run = match.group(1)
        starts = [0]
        if len(run) > 96:
            starts.extend(range(0, len(run) - 63, 32))
            starts.append(len(run) - 64)
        for start in set(starts):
            if start + 64 > len(run):
                continue
            candidate = bytes.fromhex(run[start:start + 64].decode("ascii"))
            if candidate in tested:
                continue
            tested.add(candidate)
            for _, _, _, salt, page in db_files:
                if salt in remaining_salts and len(page) == 4096 and verify_enc_key(candidate, page):
                    key_map[salt] = candidate.hex()
                    remaining_salts.discard(salt)
                    found += 1
    return found


def scan_cipher_references(read, regions, name_addresses, db_files, key_map,
                           remaining_salts, print_fn=print):
    if not name_addresses or not remaining_salts:
        return {"references": 0, "decoded": 0, "found": 0}
    pattern = re.compile(b"|".join(
        re.escape(struct.pack("<QQ", address, len(CIPHER_NAME)))
        for address in sorted(name_addresses)
    ))
    seen = set()
    tested = set()
    stats = {"references": 0, "decoded": 0, "found": 0}
    for base, data in memory_chunks(read, regions):
        for match in pattern.finditer(data):
            reference = base + match.start()
            if reference in seen:
                continue
            seen.add(reference)
            stats["references"] += 1
            decoded = decode_cipher_node(read, reference, name_addresses)
            if decoded is None:
                continue
            stats["decoded"] += 1
            found = verify_decoded_keys(decoded, db_files, key_map, remaining_salts, tested)
            stats["found"] += found
            if found:
                print_fn(f"  [Config.Cipher] 已验证 {found} 个数据库密钥（不输出密钥内容）")
            if not remaining_salts:
                return stats
    return stats
