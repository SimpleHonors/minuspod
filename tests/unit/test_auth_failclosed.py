"""Regression tests for the no-password OPEN policy and the IPv4-mapped IPv6
lockout normalization (midsize-backend-1).

Operator decision (2026-06-25): when no ``app_password`` is set the instance is
fully open -- every route, including mutating and sensitive ones, is allowed.
Setting an app password re-enables session auth + CSRF. These tests guard that
the no-password path stays OPEN so a future upstream merge cannot silently
re-close it (the old api-rest-4 fail-closed gate was removed on purpose).
"""
import os
import sys
import tempfile

import pytest

_test_data_dir = tempfile.mkdtemp(prefix='authopen_test_')
os.environ.setdefault('SECRET_KEY', 'authopen-test-secret')
os.environ.setdefault('DATA_DIR', _test_data_dir)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src'))

import database
import storage as storage_mod
database.Database._instance = None
database.Database.__init__.__defaults__ = (_test_data_dir,)
storage_mod.Storage.__init__.__defaults__ = (_test_data_dir,)

from main_app import app
from api import check_auth
from utils.validation import is_public_ip_for_lockout


@pytest.mark.parametrize("method,path", [
    ("DELETE", "/api/v1/feeds/some-slug"),
    ("PUT", "/api/v1/feeds/some-slug"),
    ("PATCH", "/api/v1/feeds/some-slug"),
    ("POST", "/api/v1/system/cleanup"),
    ("PUT", "/api/v1/providers/anthropic"),
    ("GET", "/api/v1/system/backup"),
])
def test_no_password_allows_every_route(method, path):
    """With no app_password set, check_auth must allow (return None) every
    route -- including the mutating/sensitive ones the old gate blocked."""
    db = database.Database()
    db.set_setting('app_password', '')
    with app.test_request_context(path, method=method):
        assert check_auth() is None, f"{method} {path} was blocked with no password set"


def test_password_set_still_requires_auth():
    """Setting a password must re-close the door: an unauthenticated mutating
    request is rejected (401) rather than allowed."""
    from werkzeug.security import generate_password_hash
    db = database.Database()
    db.set_setting('app_password', generate_password_hash('OpenPolicyTest123', method='scrypt'))
    try:
        with app.test_request_context('/api/v1/feeds/some-slug', method='DELETE'):
            resp = check_auth()
            assert resp is not None and resp.status_code == 401
    finally:
        db.set_setting('app_password', '')


def test_ipv4_mapped_ipv6_public_counts_as_public():
    assert is_public_ip_for_lockout('::ffff:8.8.8.8') is True
    assert is_public_ip_for_lockout('8.8.8.8') is True


def test_ipv4_mapped_ipv6_private_does_not_count_as_public():
    assert is_public_ip_for_lockout('::ffff:192.168.1.1') is False
    assert is_public_ip_for_lockout('192.168.1.1') is False
