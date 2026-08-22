// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package healthcheck

import (
	"testing"

	apiclient "github.com/daytonaio/daytona/libs/api-client-go"
)

func TestBuildServiceHealthAlwaysReportsLocalVolumeCapability(t *testing.T) {
	dockerHealth := apiclient.RunnerServiceHealth{ServiceName: "docker", Healthy: true}

	services := buildServiceHealth(dockerHealth)
	if len(services) != 2 || services[1].ServiceName != "local-volume" || !services[1].Healthy {
		t.Fatalf("service health = %#v, want healthy local-volume capability", services)
	}
}
