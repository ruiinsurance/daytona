// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package runner

import (
	"testing"

	"github.com/daytonaio/runner/pkg/models"
)

func TestAppendLocalVolumeServiceInfoReportsCapabilityOnlyWhenEnabled(t *testing.T) {
	dockerHealth := models.RunnerServiceInfo{ServiceName: "docker", Healthy: true}
	disabled := appendLocalVolumeServiceInfo([]models.RunnerServiceInfo{dockerHealth}, false)
	if len(disabled) != 1 {
		t.Fatalf("disabled service health length = %d, want 1", len(disabled))
	}

	enabled := appendLocalVolumeServiceInfo([]models.RunnerServiceInfo{dockerHealth}, true)
	if len(enabled) != 2 || enabled[1].ServiceName != "local-volume" || !enabled[1].Healthy {
		t.Fatalf("enabled service health = %#v, want healthy local-volume capability", enabled)
	}
}
