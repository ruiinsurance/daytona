/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

const STORAGE_AGENT_ERROR_CODES = new Set([
  'storage_agent_failed',
  'storage_agent_timeout',
  'storage_agent_request_invalid',
  'storage_agent_request_failed',
  'storage_agent_response_invalid',
  'storage_agent_runner_unavailable',
  'storage_agent_payload_invalid',
  'storage_agent_owner_missing',
  'storage_agent_lease_missing',
  'storage_agent_target_manifest_mismatch',
  'storage_agent_start_failed',
  'storage_agent_container_inspect_failed',
  'storage_agent_mount_prepare_failed',
  'storage_agent_container_start_failed',
  'storage_agent_container_readiness_failed',
  'storage_agent_mount_verification_failed',
  'storage_agent_disabled',
])

const STORAGE_AGENT_HTTP_ERROR_RE = /^storage_agent_http_[1-5][0-9]{2}$/

export function isStorageAgentErrorCode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    (STORAGE_AGENT_ERROR_CODES.has(value) || STORAGE_AGENT_HTTP_ERROR_RE.test(value))
  )
}
