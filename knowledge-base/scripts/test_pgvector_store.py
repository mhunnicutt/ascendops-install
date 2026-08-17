import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

MODULE_PATH = Path(__file__).with_name("pgvector_store.py")
MODULE_NAME = "pgvector_store_under_test"


def load_pgvector_store():
    spec = importlib.util.spec_from_file_location(MODULE_NAME, MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    # Register in sys.modules so @patch("pgvector_store_under_test....")
    # string-path lookups (which resolve via importlib.import_module) find
    # this already-loaded instance instead of re-importing from scratch.
    sys.modules[MODULE_NAME] = module
    spec.loader.exec_module(module)
    return module


class WhereToTypeFiltersTest(unittest.TestCase):
    def setUp(self):
        self.pv = load_pgvector_store()

    def test_none_where_returns_none(self):
        self.assertIsNone(self.pv._where_to_type_filters(None))

    def test_empty_dict_returns_none(self):
        self.assertIsNone(self.pv._where_to_type_filters({}))

    def test_simple_type_filter(self):
        self.assertEqual(self.pv._where_to_type_filters({"type": "image"}), ["image"])

    def test_audio_or_filter_maps_to_both_values(self):
        where = {"$or": [{"type": "audio"}, {"type": "audio_chunk"}]}
        self.assertEqual(self.pv._where_to_type_filters(where), ["audio", "audio_chunk"])

    def test_or_with_missing_type_keys_skipped(self):
        where = {"$or": [{"type": "audio"}, {"other": "x"}]}
        self.assertEqual(self.pv._where_to_type_filters(where), ["audio"])


class PgInEscapeTest(unittest.TestCase):
    def setUp(self):
        self.pv = load_pgvector_store()

    def test_plain_value_unquoted(self):
        self.assertEqual(self.pv._pg_in_escape("abc123"), "abc123")

    def test_value_with_comma_quoted(self):
        self.assertEqual(self.pv._pg_in_escape("a,b"), '"a,b"')

    def test_value_with_embedded_quote_escaped(self):
        self.assertEqual(self.pv._pg_in_escape('a"b'), '"a\\"b"')


class PgvectorCollectionQueryTest(unittest.TestCase):
    """Verifies query() reshapes the RPC's flat row list into chromadb's
    nested-list result shape, since every downstream caller in mmrag.py
    indexes results["ids"][0][i] etc."""

    def setUp(self):
        self.pv = load_pgvector_store()
        self.env_patch = patch.dict(
            "os.environ",
            {"SUPABASE_URL": "https://example.supabase.co", "SUPABASE_API_KEY": "test-key"},
        )
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)

    @patch("pgvector_store_under_test.requests.request")
    def test_query_reshapes_rows_into_nested_lists(self, mock_request):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = [
            {"id": "doc1", "document": "hello", "metadata": {"type": "text"}, "similarity": 0.9},
            {"id": "doc2", "document": "world", "metadata": {"type": "text"}, "similarity": 0.7},
        ]
        mock_request.return_value = mock_resp

        collection = self.pv.PgvectorCollection("agent-anna")
        results = collection.query(query_embeddings=[[0.1, 0.2]], n_results=5)

        self.assertEqual(results["ids"], [["doc1", "doc2"]])
        self.assertEqual(results["documents"], [["hello", "world"]])
        self.assertEqual(results["metadatas"], [[{"type": "text"}, {"type": "text"}]])
        self.assertAlmostEqual(results["distances"][0][0], 0.1)
        self.assertAlmostEqual(results["distances"][0][1], 0.3)

    @patch("pgvector_store_under_test.requests.request")
    def test_query_empty_results(self, mock_request):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = []
        mock_request.return_value = mock_resp

        collection = self.pv.PgvectorCollection("agent-anna")
        results = collection.query(query_embeddings=[[0.1, 0.2]], n_results=5)
        self.assertEqual(results["ids"], [[]])

    @patch("pgvector_store_under_test.requests.request")
    def test_query_error_response_raises(self, mock_request):
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_resp.text = "internal error"
        mock_request.return_value = mock_resp

        collection = self.pv.PgvectorCollection("agent-anna")
        with self.assertRaises(self.pv.PgvectorError):
            collection.query(query_embeddings=[[0.1, 0.2]], n_results=5)


class PgvectorCollectionUpsertTest(unittest.TestCase):
    def setUp(self):
        self.pv = load_pgvector_store()
        self.env_patch = patch.dict(
            "os.environ",
            {"SUPABASE_URL": "https://example.supabase.co", "SUPABASE_API_KEY": "test-key"},
        )
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)

    @patch("pgvector_store_under_test.requests.request")
    def test_upsert_builds_correct_rows(self, mock_request):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_request.return_value = mock_resp

        collection = self.pv.PgvectorCollection("agent-anna")
        collection.upsert(
            ids=["a", "b"],
            embeddings=[[0.1], [0.2]],
            documents=["doc a", "doc b"],
            metadatas=[{"type": "text"}, {"type": "pdf_page"}],
        )

        _, kwargs = mock_request.call_args
        rows = kwargs["json"]
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0], {"id": "a", "collection": "agent-anna", "embedding": [0.1], "document": "doc a", "metadata": {"type": "text"}})
        self.assertEqual(kwargs["params"]["on_conflict"], "collection,id")
        self.assertEqual(kwargs["headers"]["Prefer"], "resolution=merge-duplicates")


class PgvectorCollectionCountTest(unittest.TestCase):
    def setUp(self):
        self.pv = load_pgvector_store()
        self.env_patch = patch.dict(
            "os.environ",
            {"SUPABASE_URL": "https://example.supabase.co", "SUPABASE_API_KEY": "test-key"},
        )
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)

    @patch("pgvector_store_under_test.requests.request")
    def test_count_parses_content_range_header(self, mock_request):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"Content-Range": "0-0/1486"}
        mock_resp.json.return_value = []
        mock_request.return_value = mock_resp

        collection = self.pv.PgvectorCollection("agent-anna")
        self.assertEqual(collection.count(), 1486)

    @patch("pgvector_store_under_test.requests.request")
    def test_count_falls_back_when_no_content_range(self, mock_request):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {}
        mock_resp.json.return_value = [{"id": "a"}]
        mock_request.return_value = mock_resp

        collection = self.pv.PgvectorCollection("agent-anna")
        self.assertEqual(collection.count(), 1)


class MissingCredentialsTest(unittest.TestCase):
    def setUp(self):
        self.pv = load_pgvector_store()

    @patch.dict("os.environ", {}, clear=True)
    def test_missing_env_raises_clear_error(self):
        with self.assertRaises(self.pv.PgvectorError):
            self.pv.PgvectorCollection("agent-anna")


if __name__ == "__main__":
    unittest.main()
