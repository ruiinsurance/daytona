/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { configuration } from './configuration'

describe('local volume configuration', () => {
  it('does not expose an enable switch', () => {
    expect(configuration).not.toHaveProperty('localVolume')
  })
})
