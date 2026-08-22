/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

const originalLocalVolumeBackendEnabled = process.env.LOCAL_VOLUME_BACKEND_ENABLED

afterEach(() => {
  if (originalLocalVolumeBackendEnabled === undefined) {
    delete process.env.LOCAL_VOLUME_BACKEND_ENABLED
  } else {
    process.env.LOCAL_VOLUME_BACKEND_ENABLED = originalLocalVolumeBackendEnabled
  }
})

async function loadConfiguration(value: string) {
  jest.resetModules()
  process.env.LOCAL_VOLUME_BACKEND_ENABLED = value
  return (await import('./configuration')).configuration
}

describe('local volume configuration', () => {
  it('is disabled by default', async () => {
    expect((await loadConfiguration('')).localVolume.enabled).toBe(false)
  })

  it('requires an explicit true value', async () => {
    expect((await loadConfiguration('true')).localVolume.enabled).toBe(true)

    expect((await loadConfiguration('1')).localVolume.enabled).toBe(false)
  })
})
