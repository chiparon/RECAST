"""Wire format for the coverage HTML execution-context explorer."""
from collections import Counter
import json


def allocate_context_codes(line_contexts, encode_int):
    counts = Counter(name for names in line_contexts for name in names)
    return {name: encode_int(rank) for rank, (name, _) in enumerate(counts.most_common())}


def serialize_contexts(codes):
    if not codes:
        return None
    return json.dumps({code: name for name, code in codes.items()}).replace("<", r"\u003c")


def encode_line(names, codes):
    if not names:
        return ""
    encoded = [codes[name] for name in names]
    width = max(map(len, encoded))
    return str(width) + "".join(code.ljust(width) for code in encoded)
