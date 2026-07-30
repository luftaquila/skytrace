package coverage

import (
	"encoding/base64"
	"encoding/binary"
	"math"
	"testing"
	"time"
)

var testOrigin = Origin{Lat: 36.372628, Lon: 127.333295}

func observation(eastNM, northNM, altitudeFT float64) VolumeRow {
	cosLat := math.Cos(testOrigin.Lat * math.Pi / 180)
	return VolumeRow{
		Lat:        testOrigin.Lat + northNM/60,
		Lon:        testOrigin.Lon + eastNM/cosLat/60,
		AltitudeFT: altitudeFT,
	}
}

func TestObservedFieldPreservesEmptyCentre(t *testing.T) {
	var rows []VolumeRow
	for _, altitude := range []float64{9000, 10500, 12000} {
		for bearing := 0; bearing < 360; bearing += 20 {
			angle := float64(bearing) * math.Pi / 180
			rows = append(rows, observation(12*math.Sin(angle), 12*math.Cos(angle), altitude))
		}
	}
	field, _, err := buildObservedCoverageField(rows, testOrigin, VolumeOptions{
		HorizontalStepNM:    1.5,
		VerticalStepFT:      750,
		HorizontalSupportNM: 2.5,
		VerticalSupportFT:   1500,
	})
	if err != nil {
		t.Fatal(err)
	}
	if field == nil || field.minObservedField <= field.isoLevel {
		t.Fatalf("observations are not contained: %#v", field)
	}
	for _, point := range field.points {
		if value := field.sample(point.eastNM, point.northNM, point.altitude); value < field.isoLevel {
			t.Fatalf("observation sampled below isolevel: %f < %f", value, field.isoLevel)
		}
	}
	if value := field.sample(0, 0, 10500); value != 0 {
		t.Fatalf("empty centre was filled: %f", value)
	}
}

func TestTrackInterpolationDoesNotBridgeAircraft(t *testing.T) {
	base := time.Date(2026, 7, 23, 0, 0, 0, 0, time.UTC)
	var rows []VolumeRow
	for index, east := range []float64{-8, -4, 4, 8} {
		row := observation(east, 0, 10000)
		row.Hex = "71f7d2"
		row.PositionAt = base.Add(time.Duration(index) * 30 * time.Second).Format(time.RFC3339Nano)
		rows = append(rows, row)
	}
	field, _, err := buildObservedCoverageField(rows, testOrigin, VolumeOptions{
		HorizontalStepNM:    1,
		VerticalStepFT:      500,
		HorizontalSupportNM: 1.5,
		VerticalSupportFT:   1000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if value := field.sample(0, 0, 10000); value < field.isoLevel {
		t.Fatalf("short track segment was not filled: %f < %f", value, field.isoLevel)
	}

	separatedRows := []VolumeRow{
		observation(-10, 0, 10000),
		observation(-10, 1, 10500),
		observation(10, 0, 10000),
		observation(10, -1, 10500),
	}
	for index := range separatedRows {
		if index < 2 {
			separatedRows[index].Hex = "aaa001"
		} else {
			separatedRows[index].Hex = "bbb002"
		}
	}
	separated, _, err := buildObservedCoverageField(separatedRows, testOrigin, VolumeOptions{
		HorizontalStepNM:    1,
		VerticalStepFT:      500,
		HorizontalSupportNM: 2,
		VerticalSupportFT:   1000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if value := separated.sample(0, 0, 10000); value != 0 {
		t.Fatalf("separate aircraft were bridged: %f", value)
	}
}

func TestMeshIsIndexedWatertightAndCompact(t *testing.T) {
	var rows []VolumeRow
	for _, altitude := range []float64{6000, 9000, 12000, 15000} {
		for bearing := 0; bearing < 360; bearing += 15 {
			angle := float64(bearing) * math.Pi / 180
			distance := 8 + altitude/3000
			rows = append(rows, observation(distance*math.Sin(angle), distance*math.Cos(angle), altitude))
		}
	}
	mesh, err := BuildObservedCoverageMesh(rows, testOrigin, VolumeOptions{
		HorizontalStepNM:    1.5,
		VerticalStepFT:      750,
		HorizontalSupportNM: 3,
		VerticalSupportFT:   1800,
	})
	if err != nil {
		t.Fatal(err)
	}
	if mesh == nil || mesh.VertexCount == 0 || mesh.TriangleCount == 0 {
		t.Fatalf("missing mesh: %#v", mesh)
	}
	positionBytes, err := base64.StdEncoding.DecodeString(mesh.Positions)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := len(positionBytes), mesh.VertexCount*3*2; got != want {
		t.Fatalf("position bytes = %d, want %d", got, want)
	}
	indexBytes, err := base64.StdEncoding.DecodeString(mesh.Indices)
	if err != nil {
		t.Fatal(err)
	}
	width := 4
	if mesh.IndexEncoding == "uint16-le-base64" {
		width = 2
	}
	indices := make([]uint32, len(indexBytes)/width)
	for index := range indices {
		if width == 2 {
			indices[index] = uint32(binary.LittleEndian.Uint16(indexBytes[index*2:]))
		} else {
			indices[index] = binary.LittleEndian.Uint32(indexBytes[index*4:])
		}
		if int(indices[index]) >= mesh.VertexCount {
			t.Fatalf("index %d exceeds vertex count %d", indices[index], mesh.VertexCount)
		}
	}
	type edge struct{ low, high uint32 }
	edges := make(map[edge]int)
	for index := 0; index < len(indices); index += 3 {
		for _, pair := range [][2]uint32{
			{indices[index], indices[index+1]},
			{indices[index+1], indices[index+2]},
			{indices[index+2], indices[index]},
		} {
			low, high := pair[0], pair[1]
			if low > high {
				low, high = high, low
			}
			edges[edge{low, high}]++
		}
	}
	for edge, count := range edges {
		if count != 2 {
			t.Fatalf("edge %#v occurs %d times", edge, count)
		}
	}
	if mesh.Stats.BinaryBytes >= mesh.TriangleCount*9*4 {
		t.Fatalf("mesh did not compact triangle soup: %d bytes", mesh.Stats.BinaryBytes)
	}
}
