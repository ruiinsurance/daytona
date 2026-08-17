/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'
import { isAbsolute, normalize } from 'node:path'

export type NfsAccessMode = 'migration' | 'remote-access'

export interface NfsMountPlan {
  mode: NfsAccessMode
  mountArgs: readonly string[]
  unmountArgs: readonly string[]
  timeoutSeconds: number
}

export function resolveNfsMigrationMount(input: {
  mode: NfsAccessMode
  server: string
  exportPath: string
  targetPath: string
  timeoutSeconds?: number
}): NfsMountPlan {
  if (input.mode !== 'migration' && input.mode !== 'remote-access') {
    throw new BadRequestException('nfs_online_path_forbidden')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(input.server)) {
    throw new BadRequestException('nfs_server_invalid')
  }
  assertCanonicalAbsolutePath(input.exportPath, 'nfs_export_path_invalid')
  assertCanonicalAbsolutePath(input.targetPath, 'nfs_target_path_invalid')
  const timeoutSeconds = input.timeoutSeconds ?? 120
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 900) {
    throw new BadRequestException('nfs_timeout_invalid')
  }
  const source = `${input.server}:${input.exportPath}`
  return {
    mode: input.mode,
    mountArgs: [
      'mount',
      '-t',
      'nfs',
      '-o',
      'ro,hard,proto=tcp,timeo=600,retrans=2',
      source,
      input.targetPath,
    ],
    unmountArgs: ['umount', '--', input.targetPath],
    timeoutSeconds,
  }
}

function assertCanonicalAbsolutePath(value: string, code: string): void {
  if (!value || !isAbsolute(value) || normalize(value) !== value || value.includes('\u0000')) {
    throw new BadRequestException(code)
  }
  const parts = value.split('/')
  if (parts.some((part) => part === '..' || part === '.')) throw new BadRequestException(code)
}
