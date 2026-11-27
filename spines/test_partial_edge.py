"""The 'cut off by the edge, part 2' rule (spine_server.partial_edge, lab 079).
Run with the cutter's venv: python -m unittest spines/test_partial_edge.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from spine_server import partial_edge  # noqa: E402

W, H = 1000, 1000


def upright(x, y0, y1, t=40):
    return [[x, y0], [x + t, y0], [x + t, y1], [x, y1]]


def lying(y, x0, x1, t=40):
    return [[x0, y], [x1, y], [x1, y + t], [x0, y + t]]


ROW = [upright(100 + 60 * k, 300, 700) for k in range(5)]  # 400 long, 40 thick, no edge


class PartialEdge(unittest.TestCase):
    def test_short_at_the_top_edge_is_dropped(self):
        self.assertEqual(partial_edge(ROW + [upright(500, 0, 200)], W, H), [False] * 5 + [True])

    def test_long_enough_at_the_edge_stays(self):
        self.assertEqual(partial_edge(ROW + [upright(500, 0, 350)], W, H)[-1], False)

    def test_sliver_at_the_side_is_dropped(self):
        self.assertEqual(partial_edge(ROW + [upright(0, 300, 700, t=10)], W, H)[-1], True)

    def test_short_whole_book_at_the_side_stays(self):
        self.assertEqual(partial_edge(ROW + [upright(960, 450, 700)], W, H)[-1], False)

    def test_close_up_every_spine_edge_to_edge_keeps_all(self):
        boxes = [upright(60 * k, 0, 1000) for k in range(10)] + [upright(700, 0, 400)]
        self.assertEqual(partial_edge(boxes, W, H), [False] * 11)

    def test_lying_books_are_compared_with_lying_books(self):
        # Three short lying books, no edge; a standing row does not make them short.
        boxes = ROW + [lying(800 + 45 * k, 300, 500) for k in range(3)] + [lying(750, 0, 180)]
        self.assertEqual(partial_edge(boxes, W, H), [False] * 8 + [False])
        self.assertEqual(partial_edge(boxes[:-1] + [lying(750, 0, 120)], W, H)[-1], True)


if __name__ == "__main__":
    unittest.main()
