"""Audio cue template mixin (#350 v2).

Per-feed user-defined ding/stinger templates. The template stores a pre-computed
MFCC matrix (float32 little-endian, row-major, shape ``(n_frames, n_coeffs)``)
which the cue template matcher slides across each episode to find recurrences.
"""
import logging
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


class CueTemplateMixin:
    """Audio cue template CRUD."""

    def create_cue_template(
        self,
        podcast_id: int,
        label: str,
        source_episode_id: Optional[str],
        source_offset_s: float,
        duration_s: float,
        sample_rate: int,
        n_coeffs: int,
        mfcc_blob: bytes,
        created_by: str = 'user',
    ) -> int:
        """Insert a cue template. Returns the new row id."""
        conn = self.get_connection()
        cursor = conn.execute(
            """INSERT INTO audio_cue_templates (
                   podcast_id, label, source_episode_id, source_offset_s,
                   duration_s, sample_rate, n_coeffs, mfcc_blob,
                   enabled, created_by
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)""",
            (
                podcast_id, label, source_episode_id, source_offset_s,
                duration_s, sample_rate, n_coeffs, mfcc_blob, created_by,
            ),
        )
        conn.commit()
        return cursor.lastrowid

    def get_cue_template(self, template_id: int) -> Optional[Dict]:
        """Return one template by id, including its mfcc blob."""
        conn = self.get_connection()
        row = conn.execute(
            "SELECT * FROM audio_cue_templates WHERE id = ?", (template_id,),
        ).fetchone()
        return dict(row) if row else None

    def list_cue_templates(
        self, podcast_id: int, include_disabled: bool = True,
    ) -> List[Dict]:
        """All templates for a feed; mfcc blob included so the matcher needs one read."""
        conn = self.get_connection()
        if include_disabled:
            cursor = conn.execute(
                "SELECT * FROM audio_cue_templates WHERE podcast_id = ? "
                "ORDER BY created_at DESC",
                (podcast_id,),
            )
        else:
            cursor = conn.execute(
                "SELECT * FROM audio_cue_templates "
                "WHERE podcast_id = ? AND enabled = 1 "
                "ORDER BY created_at DESC",
                (podcast_id,),
            )
        return [dict(row) for row in cursor.fetchall()]

    def list_cue_templates_metadata(self, podcast_id: int) -> List[Dict]:
        """List without the mfcc blob, for UI listings."""
        conn = self.get_connection()
        cursor = conn.execute(
            "SELECT id, podcast_id, label, source_episode_id, source_offset_s, "
            "duration_s, sample_rate, n_coeffs, enabled, created_at, created_by "
            "FROM audio_cue_templates WHERE podcast_id = ? "
            "ORDER BY created_at DESC",
            (podcast_id,),
        )
        return [dict(row) for row in cursor.fetchall()]

    def update_cue_template(
        self,
        template_id: int,
        label: Optional[str] = None,
        enabled: Optional[bool] = None,
    ) -> bool:
        """Patch label and/or enabled. Returns True if a row was updated."""
        sets = []
        args: list = []
        if label is not None:
            sets.append("label = ?")
            args.append(label)
        if enabled is not None:
            sets.append("enabled = ?")
            args.append(1 if enabled else 0)
        if not sets:
            return False
        args.append(template_id)
        conn = self.get_connection()
        cursor = conn.execute(
            f"UPDATE audio_cue_templates SET {', '.join(sets)} WHERE id = ?",
            tuple(args),
        )
        conn.commit()
        return cursor.rowcount > 0

    def delete_cue_template(self, template_id: int) -> bool:
        """Remove a template. Returns True if a row was deleted."""
        conn = self.get_connection()
        cursor = conn.execute(
            "DELETE FROM audio_cue_templates WHERE id = ?", (template_id,),
        )
        conn.commit()
        return cursor.rowcount > 0

    def feed_has_enabled_cue_templates(self, podcast_id: int) -> bool:
        """Cheap existence check for the per-feed matcher selection."""
        conn = self.get_connection()
        row = conn.execute(
            "SELECT 1 FROM audio_cue_templates "
            "WHERE podcast_id = ? AND enabled = 1 LIMIT 1",
            (podcast_id,),
        ).fetchone()
        return row is not None
