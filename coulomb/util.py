import cbor2
import nacl.signing


def write_cbor(entries):
    for name, value in entries.items():
        with open(name, 'wb') as f:
            cbor2.dump(value, f, canonical=True)


def read_cbor(*filenames):
    results = []

    for fname in filenames:
        with open(fname, 'rb') as f:
            results.append(cbor2.load(f))

    if len(results) == 1:
        return results[0]

    return dict(zip(filenames, results))


def get_signatures(message, signature_files):
    result = {}
    for s in signature_files:
        key = read_cbor(s)['signing']
        key = nacl.signing.SigningKey(key)
        name = bytes(key.verify_key).hex()
        result[name] = key.sign(message).signature

    return result
