#!/usr/bin/python3
"""The first test of the accessibility bridge.

`athanor-desktop-bridge.py` decides what the agent believes is on the screen and which widget an
approved action lands on, and until this file it had no test of any kind - not the tree walk, not
the node ids, not the state vocabulary. Two defects lived there for exactly that reason: states
were emitted under truncated names no consumer could match, and a node id was a bare positional
path resolved once to write the approval card and again to perform the action, with nothing
holding the two resolutions together.

`pyatspi` is not importable off a Linux desktop session, so the tree here is a fake with the same
surface the real one presents: indexing, `childCount`, `getRoleName`, `getState().getStates()`, and
interface queries that raise for the interfaces a node does not implement. That is enough to
measure everything above, and it runs anywhere python3 does.

Run directly (`python3 athanor-desktop-bridge.test.py`) or through the runner's suite, which
spawns it from `desktop.test.ts`.
"""

import importlib.util
import os
import unittest

_SPEC = importlib.util.spec_from_file_location(
    "athanor_desktop_bridge",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "athanor-desktop-bridge.py"),
)
bridge = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(bridge)


class FakeState:
    def __init__(self, states):
        self._states = states

    def getStates(self):
        return list(self._states)


class FakeStateType(str):
    """How pyatspi prints a state: its C constant, not a friendly name."""

    def __str__(self):
        return str.__str__(self)


class FakeNode:
    """A node with only the interfaces it was given, because that is how AT-SPI answers."""

    def __init__(self, role, name, states=(), children=(), actions=(), bounds=None, text=None):
        self.name = name
        self.description = ""
        self._role = role
        self._states = [FakeStateType(state) for state in states]
        self._children = list(children)
        self._actions = list(actions)
        self._bounds = bounds
        self._text = text
        self.performed = []

    # -- the shape `children()` and `node_at` walk --------------------------------------------
    @property
    def childCount(self):
        return len(self._children)

    def __getitem__(self, index):
        return self._children[index]

    def getRoleName(self):
        return self._role

    def getState(self):
        return FakeState(self._states)

    # -- interfaces, each raising when this node does not implement it ------------------------
    def queryComponent(self):
        if self._bounds is None:
            raise NotImplementedError("no component")
        node = self

        class Component:
            def getExtents(self, _coords):
                class Rect:
                    x, y, width, height = node._bounds

                return Rect()

            def grabFocus(self):
                node.performed.append(("focus",))
                return True

        return Component()

    def queryAction(self):
        if not self._actions:
            raise NotImplementedError("no action")
        node = self

        class Action:
            nActions = len(node._actions)

            def getName(self, index):
                return node._actions[index]

            def doAction(self, index):
                node.performed.append(("invoke", index))
                return True

        return Action()

    def queryEditableText(self):
        if self._text is None:
            raise NotImplementedError("not editable")
        node = self

        class Editable:
            def setTextContents(self, value):
                node.performed.append(("set_text", value))
                return True

        return Editable()

    def queryText(self):
        if self._text is None:
            raise NotImplementedError("no text")
        node = self

        class Text:
            characterCount = len(node._text)

            def getText(self, start, end):
                return node._text[start:end]

        return Text()


BUTTON_STATES = (
    "STATE_ENABLED",
    "STATE_FOCUSABLE",
    "STATE_SENSITIVE",
    "STATE_SHOWING",
    "STATE_VISIBLE",
)


def tree():
    """One window, a toolbar with two buttons, and a read-only field beside them."""
    save = FakeNode("push button", "Save", BUTTON_STATES, actions=["click"], bounds=(10, 20, 60, 24))
    discard = FakeNode(
        "push button", "Don't Save", BUTTON_STATES, actions=["click"], bounds=(80, 20, 90, 24)
    )
    account = FakeNode(
        "text",
        "Account number",
        ("STATE_ENABLED", "STATE_READ_ONLY", "STATE_SENSITIVE", "STATE_SINGLE_LINE"),
        bounds=(10, 60, 200, 24),
        text="4242",
    )
    toolbar = FakeNode("tool bar", "", BUTTON_STATES, children=[save, discard])
    window = FakeNode("frame", "Text Editor", BUTTON_STATES, children=[toolbar, account])
    return FakeNode("desktop frame", "main", children=[window]), save, discard, account


class StateVocabulary(unittest.TestCase):
    def test_introspection_enum_nicknames_survive_numeric_string_conversion(self):
        class NumericState:
            value_nick = "read-only"
            def __str__(self):
                return "43"
        self.assertEqual(bridge.state_name(NumericState()), "read_only")

    def test_numeric_states_use_the_installed_binding_vocabulary(self):
        from unittest.mock import patch
        class Binding:
            @staticmethod
            def StateType(value):
                return FakeStateType("STATE_FOCUSED") if value == 12 else FakeStateType("STATE_INVALID")
        with patch.object(bridge, "atspi", return_value=Binding):
            self.assertEqual(bridge.state_name(12), "focused")

    def test_keeps_the_whole_name_rather_than_its_last_word(self):
        self.assertEqual(bridge.state_name(FakeStateType("STATE_READ_ONLY")), "read_only")
        self.assertEqual(bridge.state_name(FakeStateType("STATE_SINGLE_LINE")), "single_line")
        self.assertEqual(bridge.state_name(FakeStateType("STATE_MULTI_LINE")), "multi_line")
        self.assertEqual(bridge.state_name(FakeStateType("STATE_SENSITIVE")), "sensitive")
        self.assertEqual(
            bridge.state_name(FakeStateType("STATE_SUPPORTS_AUTOCOMPLETION")),
            "supports_autocompletion",
        )

    def test_single_line_and_multi_line_are_not_the_same_word(self):
        # The old `split("_")[-1]` made both of them `line`, so two opposite facts about a field
        # arrived under one name.
        self.assertNotEqual(
            bridge.state_name(FakeStateType("STATE_SINGLE_LINE")),
            bridge.state_name(FakeStateType("STATE_MULTI_LINE")),
        )

    def test_reads_the_same_name_out_of_the_introspection_wrapper(self):
        printed = "<enum ATSPI_STATE_READ_ONLY of type Atspi.StateType>"
        self.assertEqual(bridge.state_name(FakeStateType(printed)), "read_only")

    def test_normalises_a_wrapper_that_already_prints_words(self):
        self.assertEqual(bridge.state_name(FakeStateType("read only")), "read_only")

    def test_a_node_reports_its_states_sorted_and_whole(self):
        _, save, _, account = tree()
        self.assertEqual(
            bridge.state_names(save),
            ["enabled", "focusable", "sensitive", "showing", "visible"],
        )
        self.assertIn("read_only", bridge.state_names(account))

    def test_a_node_with_no_state_interface_reports_nothing_rather_than_failing(self):
        class Mute:
            def getState(self):
                raise RuntimeError("gone")

        self.assertEqual(bridge.state_names(Mute()), [])


class NodeIdentity(unittest.TestCase):
    def test_an_id_carries_where_it_is_and_what_it_was(self):
        root, save, _, _ = tree()
        observed = bridge.observe(50, root)
        ids = {node["name"]: node["id"] for node in observed["nodes"]}
        self.assertEqual(ids["Save"], bridge.node_id_for("0/0/0", "push button", "Save"))
        self.assertRegex(ids["Save"], r"^0/0/0#[0-9a-f]{8}$")
        # The fingerprint is over role and name together, so two buttons in the same toolbar are
        # distinguishable and the same button in two places is not confused with itself.
        self.assertNotEqual(ids["Save"].split("#")[1], ids["Don't Save"].split("#")[1])

    def test_children_point_at_the_parent_id_that_is_in_the_list(self):
        root, _, _, _ = tree()
        nodes = bridge.observe(50, root)["nodes"]
        byId = {node["id"]: node for node in nodes}
        save = next(node for node in nodes if node["name"] == "Save")
        self.assertIn(save["parentId"], byId)
        self.assertEqual(byId[save["parentId"]]["role"], "tool bar")

    def test_resolves_the_node_the_id_was_minted_from(self):
        root, save, _, _ = tree()
        node_id = bridge.node_id_for("0/0/0", "push button", "Save")
        self.assertIs(bridge.node_at(node_id, root), save)

    def test_refuses_when_the_path_now_holds_something_else(self):
        """The defect this exists for: the dialog moved between the card and the action."""
        root, _, _, _ = tree()
        node_id = bridge.node_id_for("0/0/0", "push button", "Save")
        # The toolbar's first button is now the destructive one - the tree moved underneath.
        root[0][0]._children.pop(0)
        with self.assertRaises(ValueError) as raised:
            bridge.node_at(node_id, root)
        message = str(raised.exception)
        self.assertIn("Don't Save", message)
        self.assertIn("observe the desktop again", message)

    def test_a_bare_path_still_resolves_for_a_read(self):
        # Describing a node is not acting on one, so a caller walking the tree by hand is answered.
        root, save, _, _ = tree()
        self.assertIs(bridge.node_at("0/0/0", root), save)

    def test_the_root_is_reachable_by_name(self):
        root, _, _, _ = tree()
        self.assertIs(bridge.node_at("root", root), root)
        self.assertIs(bridge.node_at("", root), root)


class Performing(unittest.TestCase):
    def test_invokes_the_control_the_id_names(self):
        root, save, _, _ = tree()
        node_id = bridge.node_id_for("0/0/0", "push button", "Save")
        result = bridge.perform({"type": "invoke", "nodeId": node_id}, root)
        self.assertEqual(save.performed, [("invoke", 0)])
        # The result says what was acted on, not merely that something was.
        self.assertEqual(result["role"], "push button")
        self.assertEqual(result["name"], "Save")
        self.assertEqual(result["nodeId"], node_id)

    def test_refuses_rather_than_invoking_whatever_moved_into_the_path(self):
        root, _, discard, _ = tree()
        node_id = bridge.node_id_for("0/0/0", "push button", "Save")
        root[0][0]._children.pop(0)
        with self.assertRaises(ValueError):
            bridge.perform({"type": "invoke", "nodeId": node_id}, root)
        # Nothing was invoked. This is the whole point: `ok: true` on "Don't Save" was the defect.
        self.assertEqual(discard.performed, [])

    def test_refuses_an_id_that_cannot_be_checked(self):
        root, save, _, _ = tree()
        with self.assertRaises(ValueError) as raised:
            bridge.perform({"type": "invoke", "nodeId": "0/0/0"}, root)
        self.assertIn("fingerprint", str(raised.exception))
        self.assertEqual(save.performed, [])

    def test_an_action_index_outside_the_control_is_refused(self):
        root, save, _, _ = tree()
        node_id = bridge.node_id_for("0/0/0", "push button", "Save")
        with self.assertRaises(ValueError):
            bridge.perform({"type": "invoke", "nodeId": node_id, "actionIndex": 7}, root)
        self.assertEqual(save.performed, [])

    def test_sets_the_text_of_an_editable_control(self):
        root, _, _, account = tree()
        node_id = bridge.node_id_for("0/1", "text", "Account number")
        bridge.perform({"type": "set_text", "nodeId": node_id, "text": "hello"}, root)
        self.assertEqual(account.performed, [("set_text", "hello")])

    def test_an_unknown_verb_is_refused_rather_than_ignored(self):
        root, _, _, _ = tree()
        node_id = bridge.node_id_for("0/0/0", "push button", "Save")
        with self.assertRaises(ValueError):
            bridge.perform({"type": "teleport", "nodeId": node_id}, root)


class Observing(unittest.TestCase):
    def test_describes_what_each_control_offers(self):
        root, _, _, account = tree()
        nodes = bridge.observe(50, root)["nodes"]
        save = next(node for node in nodes if node["name"] == "Save")
        self.assertEqual(save["actions"], ["click"])
        self.assertEqual(save["interfaces"], ["component", "action"])
        self.assertEqual(save["bounds"], {"x": 10, "y": 20, "width": 60, "height": 24})
        field = next(node for node in nodes if node["name"] == "Account number")
        self.assertEqual(field["text"], "4242")
        self.assertIn("editable_text", field["interfaces"])

    def test_holds_to_the_node_budget_it_was_given(self):
        root, _, _, _ = tree()
        self.assertEqual(len(bridge.observe(2, root)["nodes"]), 2)

    def test_marks_a_control_whose_name_says_it_holds_a_secret(self):
        secret = FakeNode("text", "One-time code", BUTTON_STATES, bounds=(0, 0, 10, 10))
        window = FakeNode("frame", "Bank", BUTTON_STATES, children=[secret])
        root = FakeNode("desktop frame", "main", children=[window])
        nodes = bridge.observe(50, root)["nodes"]
        self.assertTrue(next(node for node in nodes if node["name"] == "One-time code")["sensitive"])

    def test_never_reads_the_contents_of_a_password_field(self):
        secret = FakeNode("password text", "Password", BUTTON_STATES, text="hunter2")
        window = FakeNode("frame", "Bank", BUTTON_STATES, children=[secret])
        root = FakeNode("desktop frame", "main", children=[window])
        described = bridge.observe(50, root)["nodes"][-1]
        self.assertNotIn("text", described)
        self.assertTrue(described["sensitive"])


class Dispatching(unittest.TestCase):
    def test_a_ping_answers_before_the_accessibility_stack_is_importable(self):
        # The readiness handshake has to answer on a host with no pyatspi at all, and say so.
        answered = bridge.dispatch({"operation": "ping"})
        self.assertIs(answered["result"]["ok"], True)
        self.assertIn("atspi", answered["result"])

    def test_an_unknown_operation_is_refused(self):
        with self.assertRaises(ValueError):
            bridge.dispatch({"operation": "screenshot"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
