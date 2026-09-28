#!/usr/bin/python3
"""Private AT-SPI bridge for the native garden agent account.

Runs either as a one-shot filter (one JSON request on stdin, one response on stdout) or, with
--serve, as a long-lived newline-delimited JSON loop. The loop exists because importing
pyatspi pulls in the whole GObject introspection stack: paying that once per session instead
of once per agent action is the difference between a desktop that responds and one that
stutters.
"""

import hashlib
import json
import re
import sys


SENSITIVE = re.compile(
    r"\b(password|passcode|one.?time|otp|verification code|credit.?card|cvv|cvc|"
    r"social security|ssn|passport|bank account|secret|token)\b",
    re.IGNORECASE,
)

_ATSPI = None


def atspi():
    """Imports pyatspi on first use, so --serve can answer a readiness probe before it."""
    global _ATSPI
    if _ATSPI is None:
        import pyatspi as module

        _ATSPI = module
    return _ATSPI


def fresh_desktop():
    desktop = atspi().Registry.getDesktop(0)
    # A request loop blocks between commands, so queued native change events cannot be the
    # authority for a later action. Retain caches within a request, then invalidate descendants.
    desktop.clear_cache()
    return desktop


def desktop_coords():
    """The coordinate type AT-SPI reports screen positions in.

    `ATSPI_COORD_TYPE_SCREEN` is zero by definition, and the constant is read through the module
    rather than hard-coded so a pyatspi that renames it still wins. The fallback matters because
    this used to be the one line in `describe` that could not run without the whole
    GObject-introspection stack present, which is why nothing about the tree walk was testable.
    """
    try:
        return getattr(atspi(), "DESKTOP_COORDS", 0)
    except Exception:
        return 0


def children(node):
    try:
        return [node[index] for index in range(node.childCount)]
    except Exception:
        return []


def state_name(value):
    """Normalize both pyatspi constants and GObject enum values to the shared state vocabulary."""
    nickname = getattr(value, "value_nick", None)
    text = nickname if isinstance(nickname, str) and nickname else str(value)
    if text.isdecimal():
        try:
            text = str(atspi().StateType(int(text)))
        except Exception:
            return "unknown"
    match = re.search(r"STATE_([A-Z0-9_]+)", text)
    if match:
        return match.group(1).lower()
    # Anything else - a wrapper that already prints "read only" - normalised to the same spelling.
    return re.sub(r"[^a-z0-9]+", "_", text.strip().lower()).strip("_")


def state_names(node):
    try:
        return sorted({state_name(value) for value in node.getState().getStates()})
    except Exception:
        return []


def role_and_name(node):
    """What a node is and what it is called - the pair a node id is fingerprinted over."""
    try:
        role = str(node.getRoleName() or "unknown")
    except Exception:
        role = "unknown"
    # Truncated here as well as in `describe`, so the fingerprint is taken over the same bytes the
    # caller was shown. A name that differs only past the 500th character is the same control.
    return role, str(getattr(node, "name", "") or "")[:500]


def node_fingerprint(role, name):
    return hashlib.sha1(f"{role}|{name}".encode("utf-8")).hexdigest()[:8]


def node_id_for(path, role, name):
    return f"{path}#{node_fingerprint(role, name)}"


def node_at(node_id, root=None):
    """Resolves a node id, and refuses when the path no longer holds what the id names.

    A node id used to be a bare positional path - `0/2/5` - resolved by walking the tree by index.
    Nothing about that path is stable: it means whatever is fifth under the second child of the
    first window at the instant it is walked. An agent reads the tree, the harness describes
    `0/2/5` as "Save" and writes an approval card for it, a dialog appears or closes, and the same
    walk a moment later arrives at "Don't Save" - which is then invoked, and reported `ok: true`.
    Two separate resolutions of a mutable path is the whole of that defect.

    The fingerprint makes the id say what it was minted from, so the second resolution can check
    the first: the path finds a node, the role and name it actually has are hashed, and a
    disagreement is refused rather than acted on. It is not a lock - the tree may still move
    between the check and the action - but it converts a silent wrong action into a refusal the
    agent can answer by observing again, which is the difference this is for.
    """
    node = fresh_desktop() if root is None else root
    path, _, fingerprint = str(node_id).partition("#")
    if path not in ("", "root"):
        for raw_index in path.split("/"):
            node = node[int(raw_index)]
    if fingerprint:
        role, name = role_and_name(node)
        if node_fingerprint(role, name) != fingerprint:
            raise ValueError(
                f'The control at {path} is now {role} "{name}", which is not what this action was '
                "computed from - observe the desktop again"
            )
    return node


def describe(node, path, parent_id):
    role, name = role_and_name(node)
    description = str(getattr(node, "description", "") or "")[:1000]
    states = state_names(node)
    interfaces = []
    actions = []
    bounds = None
    text = None
    try:
        component = node.queryComponent()
        interfaces.append("component")
        rect = component.getExtents(desktop_coords())
        bounds = {"x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height}
    except Exception:
        pass
    try:
        action = node.queryAction()
        interfaces.append("action")
        actions = [str(action.getName(index) or "") for index in range(action.nActions)]
    except Exception:
        pass
    try:
        node.queryEditableText()
        interfaces.append("editable_text")
    except Exception:
        pass
    try:
        text_iface = node.queryText()
        interfaces.append("text")
        if "password text" not in role.lower():
            text = str(text_iface.getText(0, min(text_iface.characterCount, 2000)) or "")
    except Exception:
        pass
    sensitive = "password" in role.lower() or bool(SENSITIVE.search(f"{name} {description} {role}"))
    result = {
        # `<path>#<sha1(role|name)[:8]>`: where it is, and what it was when the agent saw it.
        "id": node_id_for(path, role, name),
        "parentId": parent_id,
        "name": name,
        "description": description,
        "role": role,
        "states": states,
        "actions": actions,
        "interfaces": interfaces,
        "bounds": bounds,
        "sensitive": sensitive,
    }
    if text is not None:
        result["text"] = text
    return result


def observe(max_nodes, desktop=None):
    desktop = fresh_desktop() if desktop is None else desktop
    nodes = []
    queue = [(child, str(index), None) for index, child in enumerate(children(desktop))]
    while queue and len(nodes) < max_nodes:
        current, path, parent_id = queue.pop(0)
        described = describe(current, path, parent_id)
        nodes.append(described)
        # Children carry the parent's minted id, not its path, so `parentId` names a node in this
        # list rather than a position that has to be resolved a second time to mean anything.
        queue.extend(
            (child, f"{path}/{index}", described["id"])
            for index, child in enumerate(children(current))
        )
    windows = [
        {"id": node["id"], "name": node["name"], "role": node["role"]}
        for node in nodes
        if node["parentId"] is None or node["role"].lower() in ("frame", "window", "dialog")
    ][:100]
    focused = next(
        (node for node in nodes if "focused" in node["states"] and node["name"]),
        next((node for node in nodes if node["name"]), None),
    )
    return {
        "activeApplication": focused["name"] if focused else "",
        "windows": windows,
        "nodes": nodes,
    }


def perform(action, root=None):
    node_id = str(action["nodeId"])
    if "#" not in node_id:
        # The lookup is folded into the action, so an id with nothing to check is an id from
        # before this bridge - or one the model composed itself - and neither can be verified.
        raise ValueError(
            f"Node id {node_id} carries no fingerprint - observe the desktop again and use the "
            "id it returns"
        )
    node = node_at(node_id, root)
    role, name = role_and_name(node)
    kind = action["type"]
    if kind == "invoke":
        accessible_action = node.queryAction()
        index = int(action.get("actionIndex", 0))
        if index < 0 or index >= accessible_action.nActions:
            raise ValueError("Accessibility action index is out of range")
        if not accessible_action.doAction(index):
            raise RuntimeError("Application declined the accessibility action")
    elif kind == "focus":
        if not node.queryComponent().grabFocus():
            raise RuntimeError("Application declined the focus request")
    elif kind == "set_text":
        node.queryEditableText().setTextContents(action.get("text", ""))
    else:
        raise ValueError(f"Unsupported semantic action: {kind}")
    # What was acted on, in the words the agent will be judged against - so the result is an
    # account of the action rather than a bare acknowledgement that something happened.
    return {"ok": True, "action": kind, "nodeId": node_id, "role": role, "name": name}


def dispatch(request):
    operation = request.get("operation")
    if operation == "observe":
        return observe(max(1, min(int(request.get("maxNodes", 900)), 2000)))
    if operation == "node":
        node_id = str(request["nodeId"])
        path = node_id.split("#", 1)[0]
        node = node_at(node_id)
        parent_id = None
        if "/" in path:
            parent_path = path.rsplit("/", 1)[0]
            try:
                parent_id = node_id_for(parent_path, *role_and_name(node_at(parent_path)))
            except Exception:
                # A parent that cannot be resolved is a tree that moved; the node itself still
                # answers, and `parentId` says nothing rather than naming a position.
                parent_id = None
        return {"result": describe(node, path, parent_id)}
    if operation == "act":
        return {"result": perform(request["action"])}
    if operation == "ping":
        # Warms the accessibility stack and tells the runner whether this session will be
        # able to answer semantic queries at all, before an agent action depends on it.
        try:
            atspi()
            available = True
        except Exception:
            available = False
        return {"result": {"ok": True, "atspi": available}}
    raise ValueError("Unsupported desktop bridge operation")


def serve():
    """One JSON request per line in, one JSON response per line out, until stdin closes."""
    while True:
        line = sys.stdin.readline()
        if not line:
            return
        if not line.strip():
            continue
        try:
            response = dispatch(json.loads(line))
        except Exception as error:
            response = {"error": str(error) or error.__class__.__name__}
        json.dump(response, sys.stdout, separators=(",", ":"))
        sys.stdout.write("\n")
        sys.stdout.flush()


def main():
    if "--serve" in sys.argv[1:]:
        serve()
        return
    json.dump(dispatch(json.load(sys.stdin)), sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
