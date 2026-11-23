"""Reader for the network.bin geometry written by build_network.py."""
import struct


def read(path):
    """-> (features, meta); each feature is (sector, prom, line, [(lat,lon)…], term)."""
    with open(path, "rb") as f:
        buf = f.read()
    if buf[:4] != b"TRK2":
        raise ValueError(f"{path}: bad magic {buf[:4]!r}, rebuild with make network")
    (n, npts, o_sector, o_term, o_prom, o_line,
     o_counts, o_coords, total) = struct.unpack_from("<9I", buf, 4)
    if total != len(buf):
        raise ValueError(f"{path}: truncated ({len(buf)} bytes, header says {total})")

    sector = buf[o_sector:o_sector + n]
    term = buf[o_term:o_term + n]
    prom = buf[o_prom:o_prom + n]
    line = struct.unpack_from(f"<{n}H", buf, o_line)
    counts = struct.unpack_from(f"<{n}H", buf, o_counts)
    coords = struct.unpack_from(f"<{npts * 2}i", buf, o_coords)

    feats, at = [], 0
    for i in range(n):
        c = counts[i]
        pts = [(coords[(at + k) * 2] / 1e5, coords[(at + k) * 2 + 1] / 1e5) for k in range(c)]
        at += c
        feats.append((sector[i], prom[i], line[i], pts, term[i]))
    return feats, {"count": n, "points": npts, "bytes": total}
