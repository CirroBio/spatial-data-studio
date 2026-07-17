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
    arrowSize: float = Field(ge=0)
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


class TextGeometry(BaseModel):
    kind: Literal["text"]
    position: Point
    text: str
    fontSize: float = Field(ge=1)
    # Radians about the anchor; defaults to 0 so labels authored before rotation
    # existed still validate.
    rotation: float = 0.0


ShapeGeometry = Annotated[
    Union[LineGeometry, BoxGeometry, TrapezoidGeometry, EllipseGeometry, TextGeometry],
    Field(discriminator="kind"),
]


class ShapeAnnotation(BaseModel):
    id: str | None = None
    label: str | None = None
    geometry: ShapeGeometry
    stroke: StrokeStyle
    # Absent/ignored for 'line' and 'text' geometries — neither has an interior to fill.
    fill: FillStyle | None = None
