package coverage

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"sort"
	"time"
)

const (
	nmToM = 1852.0
	ftToM = 0.3048
)

var cubeOffsets = [8][3]int{
	{0, 0, 0},
	{1, 0, 0},
	{1, 1, 0},
	{0, 1, 0},
	{0, 0, 1},
	{1, 0, 1},
	{1, 1, 1},
	{0, 1, 1},
}

var cubeEdges = [12][2]int{
	{0, 1}, {1, 2}, {2, 3}, {3, 0},
	{4, 5}, {5, 6}, {6, 7}, {7, 4},
	{0, 4}, {1, 5}, {2, 6}, {3, 7},
}

type Origin struct {
	Lat float64
	Lon float64
}

type VolumeRow struct {
	Hex        string
	PositionAt string
	Lat        float64
	Lon        float64
	AltitudeFT float64
}

type VolumeOptions struct {
	HorizontalStepNM             float64
	VerticalStepFT               float64
	HorizontalSupportNM          float64
	VerticalSupportFT            float64
	HorizontalInterpolationCells int
	HorizontalSmoothingPasses    int
	VerticalSmoothingPasses      int
	SmoothingIterations          int
	MaxCells                     int
	MaxTriangles                 int
	IsoLevel                     float64
	MaxSegmentSeconds            float64
	MaxSegmentNM                 float64
	MaxSegmentAltitudeFT         float64
	// ExplicitPostProcessing preserves zero interpolation/smoothing values. The
	// public server always sets this because zero is a valid configuration value.
	ExplicitPostProcessing bool
}

type MeshStats struct {
	Grid             [3]int  `json:"grid"`
	GridNodes        int     `json:"gridNodes"`
	OccupiedNodes    int     `json:"occupiedNodes"`
	NonManifoldEdges int     `json:"nonManifoldEdges"`
	MinObservedField float64 `json:"minObservedField"`
	GeneratedMS      float64 `json:"generatedMs"`
	BinaryBytes      int     `json:"binaryBytes"`
}

type Mesh struct {
	Type                         string     `json:"type"`
	Origin                       [2]float64 `json:"origin"`
	Encoding                     string     `json:"encoding"`
	Positions                    string     `json:"positions"`
	PositionBounds               [6]float64 `json:"positionBounds"`
	IndexEncoding                string     `json:"indexEncoding"`
	Indices                      string     `json:"indices"`
	VertexCount                  int        `json:"vertexCount"`
	TriangleCount                int        `json:"triangleCount"`
	SourcePointCount             int        `json:"sourcePointCount"`
	SamplePointCount             int        `json:"samplePointCount"`
	HorizontalStepNM             float64    `json:"horizontalStepNm"`
	VerticalStepFT               float64    `json:"verticalStepFt"`
	SupportHorizontalNM          float64    `json:"supportHorizontalNm"`
	SupportVerticalFT            float64    `json:"supportVerticalFt"`
	HorizontalInterpolationCells int        `json:"horizontalInterpolationCells"`
	HorizontalSmoothingPasses    int        `json:"horizontalSmoothingPasses"`
	VerticalSmoothingPasses      int        `json:"verticalSmoothingPasses"`
	SmoothingIterations          int        `json:"smoothingIterations"`
	IsoLevel                     float64    `json:"isoLevel"`
	Stats                        MeshStats  `json:"stats"`
}

type localPoint struct {
	eastNM    float64
	northNM   float64
	altitude  float64
	hex       string
	timeMS    int64
	hasTimeMS bool
}

type fieldOptions struct {
	horizontalStepNM             float64
	verticalStepFT               float64
	horizontalSupportNM          float64
	verticalSupportFT            float64
	horizontalInterpolationCells int
	horizontalSmoothingPasses    int
	verticalSmoothingPasses      int
	maxSegmentSeconds            float64
	maxSegmentNM                 float64
	maxSegmentAltitudeFT         float64
}

type observedField struct {
	nx, ny, nz int
	fieldOptions
	minEastNM, minNorthNM      float64
	minAltitudeFT              float64
	values                     []float32
	points, samples            []localPoint
	isoLevel, minObservedField float64
}

type fieldBounds struct {
	minEastNM, maxEastNM         float64
	minNorthNM, maxNorthNM       float64
	minAltitudeFT, maxAltitudeFT float64
}

type surface struct {
	positions []float32
	indices   []uint32
}

func defaultVolumeOptions(raw VolumeOptions) VolumeOptions {
	raw.HorizontalStepNM = maxFloat(0.75, defaultFloat(raw.HorizontalStepNM, 2))
	raw.VerticalStepFT = maxFloat(250, defaultFloat(raw.VerticalStepFT, 800))
	raw.HorizontalSupportNM = defaultFloat(raw.HorizontalSupportNM, 4.5)
	raw.VerticalSupportFT = defaultFloat(raw.VerticalSupportFT, 2500)
	raw.MaxCells = maxInt(25000, defaultInt(raw.MaxCells, 1200000))
	raw.MaxTriangles = maxInt(1000, defaultInt(raw.MaxTriangles, 200000))
	raw.IsoLevel = clamp(defaultFloat(raw.IsoLevel, 0.16), 0.02, 0.8)
	if !raw.ExplicitPostProcessing && raw.HorizontalInterpolationCells == 0 {
		raw.HorizontalInterpolationCells = 2
	}
	raw.HorizontalInterpolationCells = clampInt(raw.HorizontalInterpolationCells, 0, 3)
	if !raw.ExplicitPostProcessing && raw.HorizontalSmoothingPasses == 0 {
		raw.HorizontalSmoothingPasses = 2
	}
	raw.HorizontalSmoothingPasses = clampInt(raw.HorizontalSmoothingPasses, 0, 2)
	if !raw.ExplicitPostProcessing && raw.VerticalSmoothingPasses == 0 {
		raw.VerticalSmoothingPasses = 4
	}
	raw.VerticalSmoothingPasses = clampInt(raw.VerticalSmoothingPasses, 0, 4)
	if !raw.ExplicitPostProcessing && raw.SmoothingIterations == 0 {
		raw.SmoothingIterations = 5
	}
	raw.SmoothingIterations = clampInt(raw.SmoothingIterations, 0, 5)
	raw.MaxSegmentSeconds = maxFloat(15, defaultFloat(raw.MaxSegmentSeconds, 90))
	raw.MaxSegmentNM = maxFloat(2, defaultFloat(raw.MaxSegmentNM, 15))
	raw.MaxSegmentAltitudeFT = maxFloat(1000, defaultFloat(raw.MaxSegmentAltitudeFT, 6000))
	return raw
}

// BuildObservedCoverageMesh turns bounded, receiver-partitioned observations into the
// compact indexed mesh consumed by the existing web client.
func BuildObservedCoverageMesh(rows []VolumeRow, origin Origin, raw VolumeOptions) (*Mesh, error) {
	started := time.Now()
	field, options, err := buildObservedCoverageField(rows, origin, raw)
	if err != nil || field == nil {
		return nil, err
	}
	initialISO := field.isoLevel
	var selected *surface
	topology := topologyCounts{openEdges: math.MaxInt, nonManifoldEdges: math.MaxInt}
	selectedISO := initialISO
	for _, factor := range []float64{1, 0.875, 0.75} {
		field.isoLevel = maxFloat(0.02, initialISO*factor)
		candidate, candidateErr := polygonize(field, options.MaxTriangles)
		if candidateErr != nil {
			return nil, candidateErr
		}
		candidateTopology := surfaceTopology(candidate)
		score := candidateTopology.openEdges*1000000 + candidateTopology.nonManifoldEdges
		bestScore := topology.openEdges*1000000 + topology.nonManifoldEdges
		if score < bestScore {
			selected = candidate
			topology = candidateTopology
			selectedISO = field.isoLevel
		}
		if score == 0 {
			break
		}
	}
	if selected == nil {
		return nil, nil
	}
	if topology.openEdges != 0 {
		return nil, fmt.Errorf("coverage occupancy surface has %d open edges", topology.openEdges)
	}
	field.isoLevel = selectedISO
	smoothed := smoothSurface(selected, options.SmoothingIterations)
	if len(smoothed.positions) == 0 || len(smoothed.indices) == 0 {
		return nil, nil
	}
	encoded := encodeMesh(smoothed)
	occupiedNodes := 0
	for _, value := range field.values {
		if float64(value) >= field.isoLevel {
			occupiedNodes++
		}
	}
	return &Mesh{
		Type:                         "observed-occupancy-surface",
		Origin:                       [2]float64{round(origin.Lon, 6), round(origin.Lat, 6)},
		Encoding:                     "quantized-uint16-le-base64",
		Positions:                    encoded.positions,
		PositionBounds:               encoded.bounds,
		IndexEncoding:                encoded.indexEncoding,
		Indices:                      encoded.indices,
		VertexCount:                  encoded.vertexCount,
		TriangleCount:                encoded.triangleCount,
		SourcePointCount:             len(field.points),
		SamplePointCount:             len(field.samples),
		HorizontalStepNM:             round(field.horizontalStepNM, 3),
		VerticalStepFT:               round(field.verticalStepFT, 1),
		SupportHorizontalNM:          round(field.horizontalSupportNM, 3),
		SupportVerticalFT:            round(field.verticalSupportFT, 1),
		HorizontalInterpolationCells: field.horizontalInterpolationCells,
		HorizontalSmoothingPasses:    field.horizontalSmoothingPasses,
		VerticalSmoothingPasses:      field.verticalSmoothingPasses,
		SmoothingIterations:          options.SmoothingIterations,
		IsoLevel:                     round(field.isoLevel, 6),
		Stats: MeshStats{
			Grid:             [3]int{field.nx, field.ny, field.nz},
			GridNodes:        len(field.values),
			OccupiedNodes:    occupiedNodes,
			NonManifoldEdges: topology.nonManifoldEdges,
			MinObservedField: round(field.minObservedField, 6),
			GeneratedMS:      math.Round(float64(time.Since(started).Microseconds())/100) / 10,
			BinaryBytes:      encoded.binaryBytes,
		},
	}, nil
}

func buildObservedCoverageField(rows []VolumeRow, origin Origin, raw VolumeOptions) (*observedField, VolumeOptions, error) {
	options := defaultVolumeOptions(raw)
	cosLat := math.Cos(origin.Lat * math.Pi / 180)
	if cosLat == 0 {
		cosLat = 1e-6
	}
	points := make([]localPoint, 0, len(rows))
	for _, row := range rows {
		if math.IsNaN(row.Lat) || math.IsInf(row.Lat, 0) ||
			math.IsNaN(row.Lon) || math.IsInf(row.Lon, 0) ||
			math.IsNaN(row.AltitudeFT) || math.IsInf(row.AltitudeFT, 0) ||
			row.AltitudeFT < 0 || row.AltitudeFT > 80000 {
			continue
		}
		point := localPoint{
			eastNM:   (row.Lon - origin.Lon) * cosLat * 60,
			northNM:  (row.Lat - origin.Lat) * 60,
			altitude: row.AltitudeFT,
			hex:      row.Hex,
		}
		if parsed, err := time.Parse(time.RFC3339Nano, row.PositionAt); err == nil {
			point.timeMS = parsed.UnixMilli()
			point.hasTimeMS = true
		}
		points = append(points, point)
	}
	if len(points) < 4 {
		return nil, options, nil
	}

	horizontalStep := options.HorizontalStepNM
	verticalStep := options.VerticalStepFT
	supportHorizontalRatio := maxFloat(1.25, options.HorizontalSupportNM/horizontalStep)
	supportVerticalRatio := maxFloat(1.25, options.VerticalSupportFT/verticalStep)
	var bounds fieldBounds
	var nx, ny, nz, nodes int
	var fieldConfig fieldOptions
	for attempt := 0; attempt < 8; attempt++ {
		fieldConfig = fieldOptions{
			horizontalStepNM:             horizontalStep,
			verticalStepFT:               verticalStep,
			horizontalSupportNM:          supportHorizontalRatio * horizontalStep,
			verticalSupportFT:            supportVerticalRatio * verticalStep,
			horizontalInterpolationCells: options.HorizontalInterpolationCells,
			horizontalSmoothingPasses:    options.HorizontalSmoothingPasses,
			verticalSmoothingPasses:      options.VerticalSmoothingPasses,
			maxSegmentSeconds:            options.MaxSegmentSeconds,
			maxSegmentNM:                 options.MaxSegmentNM,
			maxSegmentAltitudeFT:         options.MaxSegmentAltitudeFT,
		}
		bounds = calculateFieldBounds(points, fieldConfig)
		nx = int(math.Round((bounds.maxEastNM-bounds.minEastNM)/horizontalStep)) + 1
		ny = int(math.Round((bounds.maxNorthNM-bounds.minNorthNM)/horizontalStep)) + 1
		nz = int(math.Round((bounds.maxAltitudeFT-bounds.minAltitudeFT)/verticalStep)) + 1
		nodes = nx * ny * nz
		if nodes <= options.MaxCells {
			break
		}
		scale := maxFloat(1.08, math.Cbrt(float64(nodes)/float64(options.MaxCells))*1.04)
		horizontalStep *= scale
		verticalStep *= scale
	}
	if nodes > options.MaxCells {
		return nil, options, fmt.Errorf("coverage occupancy grid %dx%dx%d exceeds %d nodes", nx, ny, nz, options.MaxCells)
	}

	samples := coverageSamples(points, fieldConfig)
	field := &observedField{
		nx:            nx,
		ny:            ny,
		nz:            nz,
		fieldOptions:  fieldConfig,
		minEastNM:     bounds.minEastNM,
		minNorthNM:    bounds.minNorthNM,
		minAltitudeFT: bounds.minAltitudeFT,
		values:        make([]float32, nodes),
		points:        points,
		samples:       samples,
		isoLevel:      options.IsoLevel,
	}
	for _, point := range samples {
		minX := maxInt(0, int(math.Ceil((point.eastNM-field.horizontalSupportNM-field.minEastNM)/horizontalStep)))
		maxX := minInt(field.nx-1, int(math.Floor((point.eastNM+field.horizontalSupportNM-field.minEastNM)/horizontalStep)))
		minY := maxInt(0, int(math.Ceil((point.northNM-field.horizontalSupportNM-field.minNorthNM)/horizontalStep)))
		maxY := minInt(field.ny-1, int(math.Floor((point.northNM+field.horizontalSupportNM-field.minNorthNM)/horizontalStep)))
		minZ := maxInt(0, int(math.Ceil((point.altitude-field.verticalSupportFT-field.minAltitudeFT)/verticalStep)))
		maxZ := minInt(field.nz-1, int(math.Floor((point.altitude+field.verticalSupportFT-field.minAltitudeFT)/verticalStep)))
		for z := minZ; z <= maxZ; z++ {
			dz := (field.minAltitudeFT + float64(z)*verticalStep - point.altitude) / field.verticalSupportFT
			for y := minY; y <= maxY; y++ {
				dy := (field.minNorthNM + float64(y)*horizontalStep - point.northNM) / field.horizontalSupportNM
				for x := minX; x <= maxX; x++ {
					dx := (field.minEastNM + float64(x)*horizontalStep - point.eastNM) / field.horizontalSupportNM
					distanceSquared := dx*dx + dy*dy + dz*dz
					if distanceSquared >= 1 {
						continue
					}
					strength := float32(math.Pow(1-distanceSquared, 2))
					index := field.gridIndex(x, y, z)
					if strength > field.values[index] {
						field.values[index] = strength
					}
				}
			}
		}
	}
	field.interpolateHorizontalGaps()
	field.smoothHorizontal()
	field.smoothVertical()

	minObserved := math.Inf(1)
	for _, point := range points {
		minObserved = minFloat(minObserved, field.sample(point.eastNM, point.northNM, point.altitude))
	}
	field.isoLevel = minFloat(options.IsoLevel, minObserved*0.9)
	field.minObservedField = minObserved
	return field, options, nil
}

func calculateFieldBounds(points []localPoint, options fieldOptions) fieldBounds {
	bounds := fieldBounds{
		minEastNM: math.Inf(1), maxEastNM: math.Inf(-1),
		minNorthNM: math.Inf(1), maxNorthNM: math.Inf(-1),
		minAltitudeFT: math.Inf(1), maxAltitudeFT: math.Inf(-1),
	}
	for _, point := range points {
		bounds.minEastNM = minFloat(bounds.minEastNM, point.eastNM)
		bounds.maxEastNM = maxFloat(bounds.maxEastNM, point.eastNM)
		bounds.minNorthNM = minFloat(bounds.minNorthNM, point.northNM)
		bounds.maxNorthNM = maxFloat(bounds.maxNorthNM, point.northNM)
		bounds.minAltitudeFT = minFloat(bounds.minAltitudeFT, point.altitude)
		bounds.maxAltitudeFT = maxFloat(bounds.maxAltitudeFT, point.altitude)
	}
	horizontalPadding := options.horizontalSupportNM +
		float64(1+options.horizontalSmoothingPasses)*options.horizontalStepNM
	verticalPadding := options.verticalSupportFT +
		float64(1+options.verticalSmoothingPasses)*options.verticalStepFT
	bounds.minEastNM = math.Floor((bounds.minEastNM-horizontalPadding)/options.horizontalStepNM) * options.horizontalStepNM
	bounds.maxEastNM = math.Ceil((bounds.maxEastNM+horizontalPadding)/options.horizontalStepNM) * options.horizontalStepNM
	bounds.minNorthNM = math.Floor((bounds.minNorthNM-horizontalPadding)/options.horizontalStepNM) * options.horizontalStepNM
	bounds.maxNorthNM = math.Ceil((bounds.maxNorthNM+horizontalPadding)/options.horizontalStepNM) * options.horizontalStepNM
	bounds.minAltitudeFT = maxFloat(
		-options.verticalSupportFT,
		math.Floor((bounds.minAltitudeFT-verticalPadding)/options.verticalStepFT)*options.verticalStepFT,
	)
	bounds.maxAltitudeFT = math.Ceil((bounds.maxAltitudeFT+verticalPadding)/options.verticalStepFT) * options.verticalStepFT
	return bounds
}

func coverageSamples(points []localPoint, options fieldOptions) []localPoint {
	samples := append([]localPoint(nil), points...)
	byAircraft := make(map[string][]localPoint)
	for _, point := range points {
		if point.hex == "" || !point.hasTimeMS {
			continue
		}
		byAircraft[point.hex] = append(byAircraft[point.hex], point)
	}
	for _, list := range byAircraft {
		sort.SliceStable(list, func(i, j int) bool { return list[i].timeMS < list[j].timeMS })
		for index := 1; index < len(list); index++ {
			a, b := list[index-1], list[index]
			dtSeconds := float64(b.timeMS-a.timeMS) / 1000
			horizontalNM := math.Hypot(b.eastNM-a.eastNM, b.northNM-a.northNM)
			if !(dtSeconds > 0 && dtSeconds <= options.maxSegmentSeconds) ||
				horizontalNM > options.maxSegmentNM ||
				math.Abs(b.altitude-a.altitude) > options.maxSegmentAltitudeFT {
				continue
			}
			steps := minInt(24, int(math.Ceil(maxFloat(
				horizontalNM/(options.horizontalStepNM*0.75),
				math.Abs(b.altitude-a.altitude)/(options.verticalStepFT*0.75),
			))))
			for step := 1; step < steps; step++ {
				fraction := float64(step) / float64(steps)
				samples = append(samples, localPoint{
					eastNM:   a.eastNM + (b.eastNM-a.eastNM)*fraction,
					northNM:  a.northNM + (b.northNM-a.northNM)*fraction,
					altitude: a.altitude + (b.altitude-a.altitude)*fraction,
				})
			}
		}
	}
	type cellKey struct{ x, y, z int64 }
	unique := make(map[cellKey]localPoint)
	order := make([]cellKey, 0, len(samples))
	horizontal := options.horizontalStepNM * 0.5
	vertical := options.verticalStepFT * 0.5
	for _, point := range samples {
		key := cellKey{
			x: int64(jsRound(point.eastNM / horizontal)),
			y: int64(jsRound(point.northNM / horizontal)),
			z: int64(jsRound(point.altitude / vertical)),
		}
		if _, exists := unique[key]; exists {
			continue
		}
		unique[key] = point
		order = append(order, key)
	}
	result := make([]localPoint, 0, len(order))
	for _, key := range order {
		result = append(result, unique[key])
	}
	return result
}

func (field *observedField) gridIndex(x, y, z int) int {
	return x + field.nx*(y+field.ny*z)
}

func (field *observedField) cellIndex(x, y, z int) int {
	return x + (field.nx-1)*(y+(field.ny-1)*z)
}

func (field *observedField) gridPoint(x, y, z int) [3]float64 {
	return [3]float64{
		(field.minEastNM + float64(x)*field.horizontalStepNM) * nmToM,
		(field.minNorthNM + float64(y)*field.horizontalStepNM) * nmToM,
		(field.minAltitudeFT + float64(z)*field.verticalStepFT) * ftToM,
	}
}

func (field *observedField) interpolateHorizontalGaps() {
	radius := field.horizontalInterpolationCells
	if radius < 1 {
		return
	}
	planeSize := field.nx * field.ny
	dilated := make([]float32, planeSize)
	closed := make([]float32, planeSize)
	for z := 0; z < field.nz; z++ {
		zOffset := z * planeSize
		for y := 0; y < field.ny; y++ {
			for x := 0; x < field.nx; x++ {
				var maximum float32
				for dy := -radius; dy <= radius; dy++ {
					nearY := y + dy
					if nearY < 0 || nearY >= field.ny {
						continue
					}
					for dx := -radius; dx <= radius; dx++ {
						nearX := x + dx
						if nearX < 0 || nearX >= field.nx {
							continue
						}
						maximum = max32(maximum, field.values[zOffset+nearX+field.nx*nearY])
					}
				}
				dilated[x+field.nx*y] = maximum
			}
		}
		for y := 0; y < field.ny; y++ {
			for x := 0; x < field.nx; x++ {
				minimum := float32(math.Inf(1))
				for dy := -radius; dy <= radius; dy++ {
					nearY := y + dy
					for dx := -radius; dx <= radius; dx++ {
						nearX := x + dx
						var value float32
						if nearX >= 0 && nearX < field.nx && nearY >= 0 && nearY < field.ny {
							value = dilated[nearX+field.nx*nearY]
						}
						minimum = min32(minimum, value)
					}
				}
				index := x + field.nx*y
				closed[index] = max32(field.values[zOffset+index], minimum)
			}
		}
		copy(field.values[zOffset:zOffset+planeSize], closed)
	}
}

func (field *observedField) smoothHorizontal() {
	if field.horizontalSmoothingPasses < 1 {
		return
	}
	planeSize := field.nx * field.ny
	horizontal := make([]float32, planeSize)
	smoothed := make([]float32, planeSize)
	for pass := 0; pass < field.horizontalSmoothingPasses; pass++ {
		for z := 0; z < field.nz; z++ {
			zOffset := z * planeSize
			for y := 0; y < field.ny; y++ {
				rowOffset := y * field.nx
				for x := 0; x < field.nx; x++ {
					var left, right float32
					if x > 0 {
						left = field.values[zOffset+rowOffset+x-1]
					}
					current := field.values[zOffset+rowOffset+x]
					if x+1 < field.nx {
						right = field.values[zOffset+rowOffset+x+1]
					}
					horizontal[rowOffset+x] = left*0.25 + current*0.5 + right*0.25
				}
			}
			for y := 0; y < field.ny; y++ {
				for x := 0; x < field.nx; x++ {
					var below, above float32
					if y > 0 {
						below = horizontal[x+field.nx*(y-1)]
					}
					current := horizontal[x+field.nx*y]
					if y+1 < field.ny {
						above = horizontal[x+field.nx*(y+1)]
					}
					smoothed[x+field.nx*y] = below*0.25 + current*0.5 + above*0.25
				}
			}
			copy(field.values[zOffset:zOffset+planeSize], smoothed)
		}
	}
}

func (field *observedField) smoothVertical() {
	if field.verticalSmoothingPasses < 1 {
		return
	}
	planeSize := field.nx * field.ny
	smoothed := make([]float32, len(field.values))
	for pass := 0; pass < field.verticalSmoothingPasses; pass++ {
		for z := 0; z < field.nz; z++ {
			zOffset := z * planeSize
			for index := 0; index < planeSize; index++ {
				var below, above float32
				if z > 0 {
					below = field.values[(z-1)*planeSize+index]
				}
				current := field.values[zOffset+index]
				if z+1 < field.nz {
					above = field.values[(z+1)*planeSize+index]
				}
				smoothed[zOffset+index] = below*0.25 + current*0.5 + above*0.25
			}
		}
		copy(field.values, smoothed)
	}
}

func (field *observedField) sample(eastNM, northNM, altitudeFT float64) float64 {
	gx := (eastNM - field.minEastNM) / field.horizontalStepNM
	gy := (northNM - field.minNorthNM) / field.horizontalStepNM
	gz := (altitudeFT - field.minAltitudeFT) / field.verticalStepFT
	if gx < 0 || gy < 0 || gz < 0 ||
		gx > float64(field.nx-1) || gy > float64(field.ny-1) || gz > float64(field.nz-1) {
		return 0
	}
	x0 := minInt(field.nx-2, int(math.Floor(gx)))
	y0 := minInt(field.ny-2, int(math.Floor(gy)))
	z0 := minInt(field.nz-2, int(math.Floor(gz)))
	tx := clamp(gx-float64(x0), 0, 1)
	ty := clamp(gy-float64(y0), 0, 1)
	tz := clamp(gz-float64(z0), 0, 1)
	var value float64
	for dz := 0; dz <= 1; dz++ {
		for dy := 0; dy <= 1; dy++ {
			for dx := 0; dx <= 1; dx++ {
				wx := 1 - tx
				wy := 1 - ty
				wz := 1 - tz
				if dx != 0 {
					wx = tx
				}
				if dy != 0 {
					wy = ty
				}
				if dz != 0 {
					wz = tz
				}
				value += float64(field.values[field.gridIndex(x0+dx, y0+dy, z0+dz)]) * wx * wy * wz
			}
		}
	}
	return value
}

func polygonize(field *observedField, maxTriangles int) (*surface, error) {
	cellIDs := make([]int32, (field.nx-1)*(field.ny-1)*(field.nz-1))
	for index := range cellIDs {
		cellIDs[index] = -1
	}
	positions := make([]float32, 0)
	for z := 0; z < field.nz-1; z++ {
		for y := 0; y < field.ny-1; y++ {
			for x := 0; x < field.nx-1; x++ {
				var values [8]float64
				insideCount := 0
				for index, offset := range cubeOffsets {
					values[index] = float64(field.values[field.gridIndex(x+offset[0], y+offset[1], z+offset[2])])
					if values[index] >= field.isoLevel {
						insideCount++
					}
				}
				if insideCount == 0 || insideCount == 8 {
					continue
				}
				var crossings [][3]float64
				for _, edge := range cubeEdges {
					a, b := edge[0], edge[1]
					if (values[a] >= field.isoLevel) == (values[b] >= field.isoLevel) {
						continue
					}
					offsetA, offsetB := cubeOffsets[a], cubeOffsets[b]
					pointA := field.gridPoint(x+offsetA[0], y+offsetA[1], z+offsetA[2])
					pointB := field.gridPoint(x+offsetB[0], y+offsetB[1], z+offsetB[2])
					crossings = append(crossings, interpolatePoint(pointA, pointB, values[a], values[b], field.isoLevel))
				}
				if len(crossings) == 0 {
					continue
				}
				var vertex [3]float64
				for _, point := range crossings {
					vertex[0] += point[0]
					vertex[1] += point[1]
					vertex[2] += point[2]
				}
				id := int32(len(positions) / 3)
				for axis := 0; axis < 3; axis++ {
					positions = append(positions, float32(vertex[axis]/float64(len(crossings))))
				}
				cellIDs[field.cellIndex(x, y, z)] = id
			}
		}
	}
	cellID := func(x, y, z int) int32 { return cellIDs[field.cellIndex(x, y, z)] }
	indices := make([]uint32, 0)
	addQuad := func(ids [4]int32, reverse bool) error {
		for _, id := range ids {
			if id < 0 {
				return nil
			}
		}
		seen := make(map[int32]struct{}, 4)
		for _, id := range ids {
			seen[id] = struct{}{}
		}
		if len(seen) < 4 {
			return nil
		}
		a, b, c, d := ids[0], ids[1], ids[2], ids[3]
		if reverse {
			b, d = d, b
		}
		indices = append(indices, uint32(a), uint32(b), uint32(c), uint32(a), uint32(c), uint32(d))
		if len(indices)/3 > maxTriangles {
			return fmt.Errorf("coverage occupancy mesh exceeds %d triangles", maxTriangles)
		}
		return nil
	}
	crossing := func(a, b float64) bool {
		return (a >= field.isoLevel) != (b >= field.isoLevel)
	}
	for z := 1; z < field.nz-1; z++ {
		for y := 1; y < field.ny-1; y++ {
			for x := 0; x < field.nx-1; x++ {
				a := float64(field.values[field.gridIndex(x, y, z)])
				b := float64(field.values[field.gridIndex(x+1, y, z)])
				if crossing(a, b) {
					if err := addQuad([4]int32{
						cellID(x, y-1, z-1), cellID(x, y, z-1),
						cellID(x, y, z), cellID(x, y-1, z),
					}, a >= field.isoLevel); err != nil {
						return nil, err
					}
				}
			}
		}
	}
	for z := 1; z < field.nz-1; z++ {
		for y := 0; y < field.ny-1; y++ {
			for x := 1; x < field.nx-1; x++ {
				a := float64(field.values[field.gridIndex(x, y, z)])
				b := float64(field.values[field.gridIndex(x, y+1, z)])
				if crossing(a, b) {
					if err := addQuad([4]int32{
						cellID(x-1, y, z-1), cellID(x-1, y, z),
						cellID(x, y, z), cellID(x, y, z-1),
					}, a < field.isoLevel); err != nil {
						return nil, err
					}
				}
			}
		}
	}
	for z := 0; z < field.nz-1; z++ {
		for y := 1; y < field.ny-1; y++ {
			for x := 1; x < field.nx-1; x++ {
				a := float64(field.values[field.gridIndex(x, y, z)])
				b := float64(field.values[field.gridIndex(x, y, z+1)])
				if crossing(a, b) {
					if err := addQuad([4]int32{
						cellID(x-1, y-1, z), cellID(x, y-1, z),
						cellID(x, y, z), cellID(x-1, y, z),
					}, a >= field.isoLevel); err != nil {
						return nil, err
					}
				}
			}
		}
	}
	return &surface{positions: positions, indices: indices}, nil
}

func interpolatePoint(a, b [3]float64, aValue, bValue, isoLevel float64) [3]float64 {
	span := bValue - aValue
	fraction := 0.5
	if math.Abs(span) >= 1e-12 {
		fraction = clamp((isoLevel-aValue)/span, 0, 1)
	}
	return [3]float64{
		a[0] + (b[0]-a[0])*fraction,
		a[1] + (b[1]-a[1])*fraction,
		a[2] + (b[2]-a[2])*fraction,
	}
}

func smoothSurface(input *surface, iterations int) *surface {
	vertexCount := len(input.positions) / 3
	iterations = clampInt(iterations, 0, 5)
	if iterations == 0 || vertexCount < 4 {
		return input
	}
	neighbors := make([]map[uint32]struct{}, vertexCount)
	for index := range neighbors {
		neighbors[index] = make(map[uint32]struct{})
	}
	connect := func(a, b uint32) {
		if a == b {
			return
		}
		neighbors[a][b] = struct{}{}
		neighbors[b][a] = struct{}{}
	}
	for index := 0; index < len(input.indices); index += 3 {
		a, b, c := input.indices[index], input.indices[index+1], input.indices[index+2]
		connect(a, b)
		connect(b, c)
		connect(c, a)
	}
	positions := append([]float32(nil), input.positions...)
	pass := func(factor float32) {
		next := make([]float32, len(positions))
		for vertex := 0; vertex < vertexCount; vertex++ {
			adjacent := neighbors[vertex]
			if len(adjacent) == 0 {
				copy(next[vertex*3:vertex*3+3], positions[vertex*3:vertex*3+3])
				continue
			}
			var average [3]float32
			for neighbor := range adjacent {
				average[0] += positions[neighbor*3]
				average[1] += positions[neighbor*3+1]
				average[2] += positions[neighbor*3+2]
			}
			for axis := 0; axis < 3; axis++ {
				average[axis] /= float32(len(adjacent))
				index := vertex*3 + axis
				next[index] = positions[index] + factor*(average[axis]-positions[index])
			}
		}
		positions = next
	}
	for iteration := 0; iteration < iterations; iteration++ {
		pass(0.42)
		pass(-0.44)
	}
	return &surface{positions: positions, indices: input.indices}
}

type topologyCounts struct {
	openEdges        int
	nonManifoldEdges int
}

func surfaceTopology(input *surface) topologyCounts {
	type edge struct{ low, high uint32 }
	edges := make(map[edge]int)
	for index := 0; index < len(input.indices); index += 3 {
		triangle := [3]uint32{input.indices[index], input.indices[index+1], input.indices[index+2]}
		for _, pair := range [][2]uint32{
			{triangle[0], triangle[1]},
			{triangle[1], triangle[2]},
			{triangle[2], triangle[0]},
		} {
			low, high := pair[0], pair[1]
			if low > high {
				low, high = high, low
			}
			edges[edge{low: low, high: high}]++
		}
	}
	var result topologyCounts
	for _, count := range edges {
		if count == 1 {
			result.openEdges++
		} else if count > 2 {
			result.nonManifoldEdges++
		}
	}
	return result
}

type encodedMesh struct {
	positions, indices string
	bounds             [6]float64
	indexEncoding      string
	vertexCount        int
	triangleCount      int
	binaryBytes        int
}

func encodeMesh(input *surface) encodedMesh {
	bounds := [6]float64{
		math.Inf(1), math.Inf(1), math.Inf(1),
		math.Inf(-1), math.Inf(-1), math.Inf(-1),
	}
	for index := 0; index < len(input.positions); index += 3 {
		for axis := 0; axis < 3; axis++ {
			value := float64(input.positions[index+axis])
			bounds[axis] = minFloat(bounds[axis], value)
			bounds[axis+3] = maxFloat(bounds[axis+3], value)
		}
	}
	spans := [3]float64{
		maxFloat(1e-6, bounds[3]-bounds[0]),
		maxFloat(1e-6, bounds[4]-bounds[1]),
		maxFloat(1e-6, bounds[5]-bounds[2]),
	}
	positionBytes := make([]byte, len(input.positions)*2)
	for index, value := range input.positions {
		axis := index % 3
		quantized := uint16(math.Round((float64(value) - bounds[axis]) / spans[axis] * 65535))
		binary.LittleEndian.PutUint16(positionBytes[index*2:], quantized)
	}
	vertexCount := len(input.positions) / 3
	indexWidth := 4
	indexEncoding := "uint32-le-base64"
	if vertexCount <= 65535 {
		indexWidth = 2
		indexEncoding = "uint16-le-base64"
	}
	indexBytes := make([]byte, len(input.indices)*indexWidth)
	for index, value := range input.indices {
		if indexWidth == 2 {
			binary.LittleEndian.PutUint16(indexBytes[index*2:], uint16(value))
		} else {
			binary.LittleEndian.PutUint32(indexBytes[index*4:], value)
		}
	}
	for index, value := range bounds {
		bounds[index] = round(value, 3)
	}
	return encodedMesh{
		positions:     base64.StdEncoding.EncodeToString(positionBytes),
		indices:       base64.StdEncoding.EncodeToString(indexBytes),
		bounds:        bounds,
		indexEncoding: indexEncoding,
		vertexCount:   vertexCount,
		triangleCount: len(input.indices) / 3,
		binaryBytes:   len(positionBytes) + len(indexBytes),
	}
}

func defaultFloat(value, fallback float64) float64 {
	if value == 0 || math.IsNaN(value) {
		return fallback
	}
	return value
}

func defaultInt(value, fallback int) int {
	if value == 0 {
		return fallback
	}
	return value
}

func clamp(value, minimum, maximum float64) float64 {
	return maxFloat(minimum, minFloat(maximum, value))
}

func clampInt(value, minimum, maximum int) int {
	return maxInt(minimum, minInt(maximum, value))
}

func minFloat(a, b float64) float64 {
	return math.Min(a, b)
}

func maxFloat(a, b float64) float64 {
	return math.Max(a, b)
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func min32(a, b float32) float32 {
	if a < b {
		return a
	}
	return b
}

func max32(a, b float32) float32 {
	if a > b {
		return a
	}
	return b
}

func round(value float64, digits int) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return value
	}
	scale := math.Pow10(digits)
	return math.Round(value*scale) / scale
}

func jsRound(value float64) float64 {
	return math.Floor(value + 0.5)
}

var errNoSurface = errors.New("coverage field has no surface")
