package httpapi

import (
	"testing"
)

func TestMedianReferenceNeedsEnoughSamplesAndResistsOutliers(t *testing.T) {
	var lats, lons []float64
	for i := 0; i < 99; i++ {
		lats = append(lats, 36.4)
		lons = append(lons, 127.3)
	}
	if medianReference(lats, lons) != nil {
		t.Fatal("reference produced below the minimum sample count")
	}
	// Contaminated tail: a handful of Dubai positions must not move the median.
	lats = append(lats, 24.8, 24.8, 24.8)
	lons = append(lons, 55.3, 55.3, 55.3)
	reference := medianReference(lats, lons)
	if reference == nil || reference.Lat != 36.4 || reference.Lon != 127.3 {
		t.Fatalf("reference = %#v", reference)
	}
}
