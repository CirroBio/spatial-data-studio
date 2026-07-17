"""Pydantic counterpart of frontend/src/schemas/annotations.ts — hand-kept in
sync field-for-field (no codegen). Validates shape-annotation job payloads
before they touch the `sdata.shapes["annotations"]` GeoDataFrame
(see sessions/shape_annotations.py).
"""
from __future__ import annotations

from typing import Literal, Union

from pydantic import BaseModel, Field
from typing_extensions import Annotated

Point = tuple[float, float]


class StrokeStyle(BaseModel):
    color: str
    width: float = Field(ge=0)
    dash: Literal["solid", "dashed", "dotted"]
    arrowStart: bool
    arrowEnd: bool
    z: int


class FillStyle(BaseModel):
    enabled: bool
    color: str
    alpha: float = Field(ge=0, le=1)
    z: int


class LineGeometry(BaseModel):
    kind: Literal["line"]
    vertices: tuple[Point, Point]


class BoxGeometry(BaseModel):
    kind: Literal["box"]
    vertices: tuple[Point, Point, Point, Point]


class TrapezoidGeometry(BaseModel):
    kind: Literal["trapezoid"]
    vertices: tuple[Point, Point, Point, Point]


class EllipseGeometry(BaseModel):
    kind: Literal["ellipse"]
    center: Point
    radiusX: float = Field(ge=0)
    radiusY: float = Field(ge=0)
    rotation: float


ShapeGeometry = Annotated[
    Union[LineGeometry, BoxGeometry, TrapezoidGeometry, EllipseGeometry],
    Field(discriminator="kind"),
]


class ShapeAnnotation(BaseModel):
    id: str | None = None
    label: str | None = None
    geometry: ShapeGeometry
    stroke: StrokeStyle
    # Absent/ignored for a 'line' geometry — a line has no interior to fill.
    fill: FillStyle | None = None
