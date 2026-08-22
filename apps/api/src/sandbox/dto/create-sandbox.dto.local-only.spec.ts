/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { CreateSandboxDto } from './create-sandbox.dto'

describe('CreateSandboxDto local-only contract', () => {
  it('rejects caller-selected storage backends', async () => {
    const dto = plainToInstance(CreateSandboxDto, {
      id: '11111111-1111-4111-8111-111111111111',
      storageBackend: 'cos',
    })

    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true })

    expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ property: 'storageBackend' })]))
  })

  it('requires a stable caller-supplied sandbox id', async () => {
    const dto = plainToInstance(CreateSandboxDto, {})

    const errors = await validate(dto)

    expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ property: 'id' })]))
  })
})
