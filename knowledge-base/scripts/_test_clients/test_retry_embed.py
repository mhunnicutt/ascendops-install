"""Behavioral tests for mmrag._retry_embed_content.

Run from knowledge-base/scripts:

    python -m _test_clients.test_retry_embed

Exits 0 on all-pass, 1 on any failure. Mirrors test_retry.py's three
scenarios for the generate_content retry path, applied to embed_content:

  1. transient_then_success: 429 -> 200 -> returns response, no raise
  2. all_exhausted: 429 -> 429 -> 429 -> raises last APIError
  3. fail_fast_nontransient: 403 (with '429' in body) -> raises immediately;
     proves the predicate is structural (.code / .status), not textual.

backoffs is passed as (0, 0, 0) so tests run in milliseconds.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag
from _test_clients import fault_injection


FAILURES = []


def _check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}: {detail}")
        FAILURES.append(label)


def test_transient_then_success():
    print("\n[test 1/3] transient_then_success: 429 -> 200")
    client = fault_injection.FaultInjectionClient(
        [], embed_script=fault_injection._parse_script("429:quota,200:ok")
    )
    response = mmrag._retry_embed_content(
        client, model="x", contents="x", config=None, backoffs=(0, 0, 0)
    )
    _check("returns response after one transient", response is not None)
    _check(
        "response.embeddings[0].values is the stub vector",
        getattr(response, "embeddings", None) is not None
        and response.embeddings[0].values == [0.0],
        detail=f"got {getattr(response, 'embeddings', None)!r}",
    )
    _check(
        "consumed exactly 2 attempts",
        client.models._embed_index == 2,
        detail=f"got {client.models._embed_index}",
    )


def test_all_exhausted():
    print("\n[test 2/3] all_exhausted: 429 -> 429 -> 429 -> re-raise")
    client = fault_injection.FaultInjectionClient(
        [], embed_script=fault_injection._parse_script("429,429,429")
    )
    raised = None
    try:
        mmrag._retry_embed_content(
            client, model="x", contents="x", config=None, backoffs=(0, 0, 0)
        )
    except Exception as e:
        raised = e
    _check("raises after all attempts exhausted", raised is not None)
    if raised is not None:
        _check("raised.code is 429", getattr(raised, "code", None) == 429)
        _check(
            "raised.status is RESOURCE_EXHAUSTED",
            getattr(raised, "status", None) == "RESOURCE_EXHAUSTED",
        )
    _check(
        "consumed exactly 3 attempts",
        client.models._embed_index == 3,
        detail=f"got {client.models._embed_index}",
    )


def test_fail_fast_nontransient():
    print("\n[test 3/3] fail_fast_nontransient: 403 (with '429' in body) -> raises immediately")
    client = fault_injection.FaultInjectionClient(
        [],
        embed_script=fault_injection._parse_script(
            "403:Permission denied for resource ID 429-pseudo,200:should not reach"
        ),
    )
    raised = None
    try:
        mmrag._retry_embed_content(
            client, model="x", contents="x", config=None, backoffs=(0, 0, 0)
        )
    except Exception as e:
        raised = e
    _check("raises immediately on non-transient", raised is not None)
    if raised is not None:
        _check("raised.code is 403", getattr(raised, "code", None) == 403)
        _check(
            "raised.status is PERMISSION_DENIED",
            getattr(raised, "status", None) == "PERMISSION_DENIED",
        )
    _check(
        "did NOT consume the second scripted attempt (predicate is structural, not textual)",
        client.models._embed_index == 1,
        detail=f"got {client.models._embed_index}",
    )


if __name__ == "__main__":
    test_transient_then_success()
    test_all_exhausted()
    test_fail_fast_nontransient()
    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} assertion(s)")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print(f"ALL PASS (3 scenarios)")
    sys.exit(0)
