import json
from unittest.mock import patch

import pytest
from src.versions import MAX_STABLE, Snapshot, VersionStore


def versions_file(tmp_path):
    return str(tmp_path / "versions.json")


def make_store(tmp_path, image_tag="v1.0.0"):
    path = versions_file(tmp_path)
    with patch("src.versions.VERSIONS_FILE", path):
        return VersionStore(image_tag=image_tag), path


# --- __init__ ---

def test_init_creates_pending_snapshot(tmp_path):
    vs, _ = make_store(tmp_path)
    pending = vs.get_current_pending()
    assert pending is not None
    assert pending.image_tag == "v1.0.0"
    assert pending.status == "PENDING"


def test_init_persists_snapshot_to_file(tmp_path):
    _, path = make_store(tmp_path)
    data = json.loads(open(path).read())
    assert len(data) == 1
    assert data[0]["image_tag"] == "v1.0.0"
    assert data[0]["status"] == "PENDING"


def test_init_loads_existing_snapshots(tmp_path):
    path = versions_file(tmp_path)
    existing = [{
        "id": "old-id",
        "timestamp": "2026-01-01T00:00:00+00:00",
        "image_tag": "v0.9.0",
        "status": "STABLE",
        "tsd_baseline": {},
        "lsi_baseline": 0.0,
    }]
    open(path, "w").write(json.dumps(existing))
    with patch("src.versions.VERSIONS_FILE", path):
        vs = VersionStore(image_tag="v1.0.0")
    all_snaps = vs.get_all()
    assert len(all_snaps) == 2
    assert all_snaps[0]["image_tag"] == "v1.0.0"   # new PENDING at front
    assert all_snaps[1]["image_tag"] == "v0.9.0"


def test_init_handles_corrupt_file(tmp_path):
    path = versions_file(tmp_path)
    open(path, "w").write("not json")
    with patch("src.versions.VERSIONS_FILE", path):
        vs = VersionStore(image_tag="v1.0.0")
    # Starts fresh with just the new PENDING
    assert len(vs.snapshots) == 1
    assert vs.snapshots[0].image_tag == "v1.0.0"


def test_init_handles_missing_file(tmp_path):
    path = str(tmp_path / "nonexistent.json")
    with patch("src.versions.VERSIONS_FILE", path):
        vs = VersionStore(image_tag="v1.0.0")
    assert len(vs.snapshots) == 1


# --- mark_stable ---

def test_mark_stable_changes_status(tmp_path):
    vs, _ = make_store(tmp_path)
    pending = vs.get_current_pending()
    vs.mark_stable(pending.id, tsd_baseline={"cpu": 5.0}, lsi_baseline=0.25)
    snap = next(s for s in vs.snapshots if s.id == pending.id)
    assert snap.status == "STABLE"
    assert snap.tsd_baseline == {"cpu": 5.0}
    assert snap.lsi_baseline == 0.25


def test_mark_stable_uses_empty_dict_when_no_baseline(tmp_path):
    vs, _ = make_store(tmp_path)
    pending = vs.get_current_pending()
    vs.mark_stable(pending.id)
    snap = next(s for s in vs.snapshots if s.id == pending.id)
    assert snap.tsd_baseline == {}
    assert snap.lsi_baseline == 0.0


def test_mark_stable_ignores_unknown_id(tmp_path):
    vs, _ = make_store(tmp_path)
    vs.mark_stable("nonexistent-id")  # must not raise
    assert vs.get_current_pending() is not None  # original pending untouched


def test_mark_stable_prunes_oldest_when_over_max(tmp_path):
    vs, _ = make_store(tmp_path)
    # Seed MAX_STABLE + 1 existing STABLE snapshots (oldest at end of list)
    for i in range(MAX_STABLE + 1):
        vs.snapshots.append(Snapshot(
            id=f"old-{i}",
            timestamp="2026-01-01T00:00:00+00:00",
            image_tag=f"v0.{i}.0",
            status="STABLE",
        ))
    pending = vs.get_current_pending()
    vs.mark_stable(pending.id)
    stable = [s for s in vs.snapshots if s.status == "STABLE"]
    assert len(stable) <= MAX_STABLE


def test_mark_stable_persists_to_file(tmp_path):
    # Patch must stay active across __init__ AND mark_stable so _persist() uses tmp_path
    path = str(tmp_path / "versions.json")
    with patch("src.versions.VERSIONS_FILE", path):
        vs = VersionStore(image_tag="v1.0.0")
        vs.mark_stable(vs.get_current_pending().id)
    data = json.loads(open(path).read())
    statuses = [d["status"] for d in data]
    assert "STABLE" in statuses


# --- mark_rolled_back ---

def test_mark_rolled_back_changes_status(tmp_path):
    vs, _ = make_store(tmp_path)
    pending = vs.get_current_pending()
    vs.mark_rolled_back(pending.id)
    assert pending.status == "ROLLED_BACK"


def test_mark_rolled_back_ignores_unknown_id(tmp_path):
    vs, _ = make_store(tmp_path)
    vs.mark_rolled_back("nonexistent-id")  # must not raise


def test_mark_rolled_back_persists_to_file(tmp_path):
    path = str(tmp_path / "versions.json")
    with patch("src.versions.VERSIONS_FILE", path):
        vs = VersionStore(image_tag="v1.0.0")
        vs.mark_rolled_back(vs.get_current_pending().id)
    data = json.loads(open(path).read())
    assert data[0]["status"] == "ROLLED_BACK"


# --- get_last_stable ---

def test_get_last_stable_none_when_no_stable(tmp_path):
    vs, _ = make_store(tmp_path)
    assert vs.get_last_stable() is None


def test_get_last_stable_returns_first_stable_in_list(tmp_path):
    vs, _ = make_store(tmp_path)
    vs.snapshots.append(Snapshot(id="s1", timestamp="t", image_tag="v0.9", status="STABLE"))
    vs.snapshots.append(Snapshot(id="s2", timestamp="t", image_tag="v0.8", status="STABLE"))
    result = vs.get_last_stable()
    assert result.id == "s1"


def test_get_last_stable_skips_non_stable(tmp_path):
    vs, _ = make_store(tmp_path)
    vs.snapshots.append(Snapshot(id="r1", timestamp="t", image_tag="v0.8", status="ROLLED_BACK"))
    vs.snapshots.append(Snapshot(id="s1", timestamp="t", image_tag="v0.9", status="STABLE"))
    result = vs.get_last_stable()
    assert result.id == "s1"


# --- get_current_pending ---

def test_get_current_pending_returns_pending(tmp_path):
    vs, _ = make_store(tmp_path)
    result = vs.get_current_pending()
    assert result is not None
    assert result.status == "PENDING"
    assert result.image_tag == "v1.0.0"


def test_get_current_pending_none_after_mark_stable(tmp_path):
    vs, _ = make_store(tmp_path)
    pending = vs.get_current_pending()
    vs.mark_stable(pending.id)
    assert vs.get_current_pending() is None


def test_get_current_pending_none_after_mark_rolled_back(tmp_path):
    vs, _ = make_store(tmp_path)
    pending = vs.get_current_pending()
    vs.mark_rolled_back(pending.id)
    assert vs.get_current_pending() is None


# --- get_all ---

def test_get_all_returns_list_of_dicts(tmp_path):
    vs, _ = make_store(tmp_path)
    result = vs.get_all()
    assert isinstance(result, list)
    assert isinstance(result[0], dict)


def test_get_all_contains_expected_fields(tmp_path):
    vs, _ = make_store(tmp_path)
    snap = vs.get_all()[0]
    assert "id" in snap
    assert "image_tag" in snap
    assert "status" in snap
    assert "timestamp" in snap


def test_get_all_reflects_current_snapshots(tmp_path):
    vs, _ = make_store(tmp_path)
    vs.snapshots.append(Snapshot(id="x", timestamp="t", image_tag="v0.9", status="STABLE"))
    assert len(vs.get_all()) == 2


# --- add_pending ---

def test_add_pending_creates_new_snapshot(tmp_path):
    vs, _ = make_store(tmp_path)
    snap = vs.add_pending(image_tag="v2.0.0", git_sha="abc123")
    assert snap.status == "PENDING"
    assert snap.image_tag == "v2.0.0"
    assert snap.git_sha == "abc123"


def test_add_pending_inserts_at_front(tmp_path):
    vs, _ = make_store(tmp_path)
    vs.add_pending(image_tag="v2.0.0")
    assert vs.snapshots[0].image_tag == "v2.0.0"


def test_add_pending_persists_to_file(tmp_path):
    path = str(tmp_path / "versions.json")
    import json
    with patch("src.versions.VERSIONS_FILE", path):
        vs = VersionStore(image_tag="v1.0.0")
        vs.add_pending(image_tag="v2.0.0", git_sha="sha999")
    with open(path) as f:
        data = json.load(f)
    tags = [d["image_tag"] for d in data]
    assert "v2.0.0" in tags


def test_add_pending_git_sha_empty_by_default(tmp_path):
    vs, _ = make_store(tmp_path)
    snap = vs.add_pending(image_tag="v2.0.0")
    assert snap.git_sha == ""


def test_add_pending_multiple_calls_stack(tmp_path):
    vs, _ = make_store(tmp_path)
    vs.add_pending(image_tag="v2.0.0")
    vs.add_pending(image_tag="v3.0.0")
    tags = [s.image_tag for s in vs.snapshots]
    assert tags[0] == "v3.0.0"
    assert tags[1] == "v2.0.0"


# --- Snapshot.git_sha field ---

def test_snapshot_git_sha_field_exists(tmp_path):
    vs, _ = make_store(tmp_path)
    pending = vs.get_current_pending()
    assert hasattr(pending, "git_sha")
    assert pending.git_sha == ""


def test_snapshot_get_all_includes_git_sha(tmp_path):
    vs, _ = make_store(tmp_path)
    vs.add_pending(image_tag="v2.0.0", git_sha="deadbeef")
    snaps = vs.get_all()
    latest = next(s for s in snaps if s["image_tag"] == "v2.0.0")
    assert latest["git_sha"] == "deadbeef"
