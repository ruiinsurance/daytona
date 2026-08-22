// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package healthcheck

import (
	"testing"

	apiclient "github.com/daytonaio/daytona/libs/api-client-go"
)

func TestBuildServiceHealthReportsLocalVolumeCapabilityOnlyWhenEnabled(t *testing.T) {
	dockerHealth := apiclient.RunnerServiceHealth{ServiceName: "docker", Healthy: true}

	disabled := buildServiceHealth(dockerHealth, false)
	if len(disabled) != 1 || disabled[0].ServiceName != "docker" {
		t.Fatalf("disabled service health = %#v, want Docker only", disabled)
	}

	enabled := buildServiceHealth(dockerHealth, true)
	if len(enabled) != 2 || enabled[1].ServiceName != "local-volume" || !enabled[1].Healthy {
		t.Fatalf("enabled service health = %#v, want healthy local-volume capability", enabled)
	}
}
