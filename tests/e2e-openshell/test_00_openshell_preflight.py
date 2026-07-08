#!/usr/bin/env python3
"""
Generic OpenShell E2E preflight checks.
"""


def test_openshell_version_ready(openshell_preflight):
    assert openshell_preflight['installed']


def test_gateway_ready(gateway_ready):
    assert gateway_ready.returncode == 0
