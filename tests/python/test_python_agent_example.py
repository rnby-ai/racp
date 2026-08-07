import importlib.util
import sys
import unittest
from pathlib import Path


EXAMPLE = (
    Path(__file__).resolve().parents[2]
    / "examples"
    / "python_golden_vector_agent.py"
)


def load_example():
    spec = importlib.util.spec_from_file_location("python_golden_vector_agent", EXAMPLE)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load Python agent example")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(spec.name, None)
        raise
    return module


class PythonGoldenVectorAgentExampleTest(unittest.TestCase):
    def test_agent_accepts_every_vector_and_emits_correlated_status(self):
        module = load_example()
        replies = module.run_golden_vector_agent_demo()
        self.assertEqual(len(replies), 3)
        self.assertTrue(all(reply.intent == module.STATUS_INTENT for reply in replies))


if __name__ == "__main__":
    unittest.main()
