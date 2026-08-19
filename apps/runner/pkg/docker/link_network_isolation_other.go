//go:build !linux

// Copyright Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package docker

import "context"

// Docker Runner network isolation is a Linux host operation. Keep non-Linux
// builds usable for tests and tooling without pretending to mutate host links.
func (d *DockerClient) clearBridgePortIsolation(_ context.Context, _ string) error {
	return nil
}
