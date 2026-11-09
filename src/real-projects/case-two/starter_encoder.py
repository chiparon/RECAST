"""Wire format for the coverage HTML execution-context explorer."""


def allocate_context_codes(line_contexts, encode_int):
    raise NotImplementedError("Assign context codes")


def serialize_contexts(codes):
    raise NotImplementedError("Produce the inline-script dictionary")


def encode_line(names, codes):
    raise NotImplementedError("Pack one line's context codes")
