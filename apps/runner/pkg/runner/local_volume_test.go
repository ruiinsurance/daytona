// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package runner

import (
	"testing"

	"github.com/daytonaio/runner/pkg/models"
)

func TestAppendLocalVolumeServiceInfoAlwaysReportsCapability(t *testing.T) {
	dockerHealth := models.RunnerServiceInfo{ServiceName: "docker", Healthy: true}
	services := appendLocalVolumeServiceInfo([]models.RunnerServiceInfo{dockerHealth})
	if len(services) != 2 || services[1].ServiceName != "local-volume" || !services[1].Healthy {
		t.Fatalf("service health = %#v, want healthy local-volume capability", services)
	}
}
