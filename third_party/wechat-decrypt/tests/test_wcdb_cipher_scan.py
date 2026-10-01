"""Synthetic memory/page fixtures; no real account data or file fingerprints."""
import hashlib
import hmac
import re
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from key_scan_common import scan_memory_for_keys
from wcdb_cipher_scan import (
    CIPHER_NAME, XOR_MASK, decode_cipher_node, memory_chunks,
    scan_cipher_references, verify_decoded_keys,
)


def fixture_page(key, salt):
    page = bytearray(salt + bytes(4096 - 16))
    mac_key = hashlib.pbkdf2_hmac("sha512", key, bytes(v ^ 0x3A for v in salt), 2, 32)
    page[-64:] = hmac.new(mac_key, page[16:4032] + struct.pack("<I", 1), hashlib.sha512).digest()
    return bytes(page)


class CipherScannerTests(unittest.TestCase):
    def setUp(self):
        self.key = bytes(range(32))
        self.salt = bytes(range(16))
        self.page = fixture_page(self.key, self.salt)
        self.dbs = [("message/message_0.db", "unused", 4096, self.salt.hex(), self.page)]

    def memory(self, payload):
        base = 0x100000
        data = bytearray(2048)
        name = base + 100
        reference = base + 400
        config = base + 800
        blob = base + 1200
        data[100:100 + len(CIPHER_NAME)] = CIPHER_NAME
        struct.pack_into("<QQ", data, 400, name, len(CIPHER_NAME))
        struct.pack_into("<Q", data, 424, config)
        struct.pack_into("<QQ", data, 800 + 0x90, blob, len(payload))
        encoded = bytes(v ^ XOR_MASK[i % len(XOR_MASK)] for i, v in enumerate(payload))
        data[1200:1200 + len(encoded)] = encoded
        def read(addr, length):
            offset = addr - base
            return bytes(data[offset:offset + length]) if 0 <= offset and offset + length <= len(data) else None
        return read, [(base, len(data))], {name}, reference

    def test_config_cipher_recovers_key_without_plaintext_hex_in_memory(self):
        payload = b"x'" + self.key.hex().encode() + self.salt.hex().encode() + b"'"
        read, regions, names, ref = self.memory(payload)
        self.assertEqual(decode_cipher_node(read, ref, names), payload)
        self.assertNotIn(payload, read(regions[0][0], regions[0][1]))
        keys, remaining = {}, {self.salt.hex()}
        stats = scan_cipher_references(read, regions, names, self.dbs, keys, remaining, lambda _: None)
        self.assertEqual(stats, {"references": 1, "decoded": 1, "found": 1})
        self.assertEqual(keys, {self.salt.hex(): self.key.hex()})
        self.assertFalse(remaining)

    def test_wrong_account_or_key_is_not_accepted(self):
        keys, remaining = {}, {self.salt.hex()}
        payload = b"x'" + bytes(reversed(self.key)).hex().encode() + b"'"
        self.assertEqual(verify_decoded_keys(payload, self.dbs, keys, remaining, set()), 0)
        self.assertEqual(keys, {})
        self.assertEqual(remaining, {self.salt.hex()})

    def test_untrusted_explicit_salt_is_not_written_as_standard_key(self):
        keys, remaining = {}, {self.salt.hex()}
        other_page = fixture_page(self.key, bytes(reversed(self.salt)))
        dbs = [("test", "unused", 4096, self.salt.hex(), self.page)]
        payload = b"X'" + bytes(reversed(self.key)).hex().encode() + other_page[:16].hex().encode() + b"'"
        self.assertEqual(verify_decoded_keys(payload, dbs, keys, remaining, set()), 0)

    def test_bad_pointer_is_skipped(self):
        read, regions, names, ref = self.memory(b"x'" + self.key.hex().encode() + b"'")
        self.assertIsNone(decode_cipher_node(read, ref, {next(iter(names)) + 1}))
        self.assertIsNone(decode_cipher_node(lambda a, n: None, ref, names))

    def test_chunk_boundaries_and_unreadable_gap(self):
        content = b"a" * 14 + CIPHER_NAME + b"z" * 20
        read = lambda a, n: content[a:a+n]
        chunks = list(memory_chunks(read, [(0, len(content))], chunk_size=16))
        self.assertTrue(any(CIPHER_NAME in data for _, data in chunks))
        def gap(a, n):
            return None if a == 16 else content[a:a+n]
        chunks = list(memory_chunks(gap, [(0, len(content))], chunk_size=16))
        self.assertFalse(any(CIPHER_NAME in data for _, data in chunks))

    def test_legacy_hex_scanner_still_recovers_key(self):
        keys, remaining = {}, {self.salt.hex()}
        data = b"x'" + self.key.hex().encode() + self.salt.hex().encode() + b"'"
        count = scan_memory_for_keys(data, re.compile(rb"x'([0-9a-fA-F]{64,192})'"), self.dbs,
                                    {self.salt.hex(): ["test"]}, keys, remaining, 0, 0, lambda _: None)
        self.assertEqual(count, 1)
        self.assertEqual(keys[self.salt.hex()], self.key.hex())


if __name__ == "__main__":
    unittest.main()
